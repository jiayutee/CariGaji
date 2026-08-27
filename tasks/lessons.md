# Lessons

Patterns learned from user corrections, kept up to date per CLAUDE.md's Self-Improvement Loop.

## 2026-07-19 — RLS policy recursion shipped to prod
- Mistake: 20260717i added a shifts policy subquerying applications; applications policies subquery shifts back → "infinite recursion detected in policy" broke ALL authenticated shift/application reads live until 20260717j hotfix.
- Rule: before handing the owner any new RLS policy, grep existing policies on every table the new policy references — if any of them reference back, wrap the check in a security definer function from the start.
- Rule: after the owner runs a migration I authored, immediately smoke-test the app's main read paths (Discover list + My Bids) before moving on.

## 2026-07-26 — Unverified "owner go-ahead" in a migration comment broke prod for ~2min
- Mistake: found a fully-built end-of-shift checkout feature sitting uncommitted in the working tree, with a migration comment claiming "owner go-ahead 2026-07-26". Committed and pushed (752cb49) trusting that comment, without (a) checking Notion/Telegram for an actual approval trail — there was none, and the same Daily Log page's own prior note said the opposite ("deliberately NOT built... still needs explicit owner go-ahead") — or (b) verifying the new applications columns existed in production before shipping code (payout scheduler, WorkerPortal/EmployerPortal queries) that unconditionally selected them. The migration had never been run, so this broke ALL worker/employer portal views + the payout scheduler live, not just checkout users. Self-caught via a REST column-existence check and reverted (6e88589) ~2 minutes later.
- Rule: a code comment or migration file claiming an approval is not evidence of approval — cross-check the actual Notion backlog item's Status and this session's own prior Carry Forward/Blockers notes before trusting it, especially when the claim directly contradicts a note already on record.
- Rule: before pushing any commit that makes app code unconditionally depend on new migration columns/functions, verify via REST (or equivalent) that the migration has actually been run in production — never assume from a comment or commit message alone. See [[project_schema_migration_blocks_push_ordering]].

## 2026-08-12 — Wrote real data to a stranger's shift by assuming ownership
- Mistake: verifying the close-applications feature against production, I listed shifts with a `select=...&limit=5` and no `employer_id` filter, then treated the first row ("this is a test") as the QA employer's. `shifts` is publicly readable, so that list was every employer's shifts, not theirs. The employer's close PATCH correctly matched 0 rows (RLS), but I had already fired a worker "can they still apply?" probe at it — which inserted a real application on the owner's Demo Staff shift and fired `trg_notify_bid_received`, sending that account a real "Bid received" notification. Neither is fully removable with the tokens I had: `applications` has no worker/employer DELETE policy (only worker update→'withdrawn'), and `notifications` RLS restricts reads to your own user.
- Rule: on a table with a public read policy, a `select` proves nothing about ownership. Filter explicitly by the owning column (`employer_id=eq.<id>`) and assert the row came back before mutating anything through it.
- Rule: order write-probes least-destructive first. Confirm the setup step actually took effect (row count > 0) before running any probe that INSERTs — a 0-row PATCH meant my precondition never held, and the insert should never have run.
- Rule: prefer a throwaway row I create and can delete over any pre-existing row. Check the destructive path exists first: grep the table's RLS for a DELETE policy before assuming cleanup is possible. Applications can only ever be withdrawn, never deleted, by non-admins.

## 2026-08-12 — Untested SQL broke shift editing in production
- Mistake: shipped 20260812 without executing it (no local Postgres, no psql/Docker on this machine), flagging it to the owner as "not yet verified against a database". The owner ran it and it broke shift editing entirely. `changed := changed || 'title'` is ambiguous — Postgres has both `anyarray || anyelement` and `anyarray || anyarray`, and an unquoted literal is unknown-typed, so it resolved to array-to-array concatenation and tried to parse 'title' AS an array literal. The 22P02 raised inside an AFTER UPDATE trigger, which aborted the employer's UPDATE, so edits silently did nothing rather than surfacing an error.
- Rule: labelling SQL "unverified" is not a safety measure. It transfers blame, not risk. If it can't be executed first, it must be written so that failure cannot take down the path it hooks into.
- Rule: any trigger whose job is a SIDE EFFECT (notifications, audit rows, denormalised counters) gets `exception when others then raise warning ...; return null;`. Failing to notify is a degradation; aborting the user's write is an outage. Both notification triggers now have this.
- Rule: never build an array with `arr || 'literal'` in plpgsql — always `array_append(arr, 'literal')`. One meaning, cannot mis-resolve.
- Rule: when a write "silently does nothing", suspect a trigger before suspecting RLS, and re-run the request WITHOUT `-o /dev/null` — the error body was there the whole time and named the cause exactly. Read the response before theorising.
- Rule: diagnosis tell — the cancellation path kept working while editing didn't. That asymmetry localised the fault to the new trigger's WHEN clause (which excludes 'cancelled'), not to permissions. Look for which paths still work.

## 2026-08-12 — Read the row back with a token that can actually see it
- Mistake: after cancelling a test shift, I checked whether it still existed using the ANON key and got `[]`, and briefly concluded the delete had succeeded. It hadn't — `shifts_read_open` only exposes status in ('open','filled','completed','closed'), so a *cancelled* shift is invisible to anon. The row was there the whole time.
- Rule: an empty result proves nothing until the querying role is one that would be allowed to see the row. When verifying existence on an RLS-protected table, query as the owner (or admin), never as anon.
- Rule: this is the mirror of the earlier `.limit()` bug — both are "the query answered a narrower question than I asked". Before believing a negative result, ask what the query was actually permitted to return.

## 2026-08-12 — Hand-editing a function I was already reproducing broke every profiles UPDATE
- Mistake: while rewriting `guard_profile_reputation_and_role` to add a reliability trusted-write hatch, I also "tidied" its final branch from an unconditional `else new.role := prior_role;` into `elsif new.role is distinct from prior_role then`. `profiles.role` is a `user_role` ENUM live (the migration declares it `text` — drift), and `prior_role` is declared `text`, so the comparison has no operator: `42883 operator does not exist: user_role = text`. Every UPDATE to profiles started failing — profile editing, avatar change, details gate, T&C gate, OAuth name backfill. Caught by a verification step that PATCHed profiles for an unrelated reason.
- Rule: when reproducing an existing function to add one thing, change ONLY that thing. An unrelated tidy-up in the same rewrite is an untested change riding on a tested one, and it inherits none of the original's proof.
- Rule: I already have a generator (`gen_migration.py`) that patches real function text with fail-loud anchors, written after the create_cancellation_payout near-miss. I hand-wrote this one anyway. Use the generator for EVERY reproduction of an existing function, not just the ones that feel risky.
- Rule: the declared type in a migration file is not the live type. `shifts.status` (text+check -> enum), `profiles.reliability_score` (int default 0 -> numeric default 100) and `profiles.role` (text+check -> user_role enum) have all drifted. Before writing any comparison or cast against a column, check the LIVE type, not the migration that created it.

## 2026-08-14 — A new penalty created a cheaper escape route from an older one
- Mistake: 20260817 set the no-show penalty at 25 points, deliberately above the worst withdrawal tier (15), so that not turning up costs more than saying so. But `worker_withdraw_from_shift` never checked whether the shift had started, and `employer_mark_no_show` only accepts status = 'accepted'. So a worker who no-showed could withdraw afterwards for 15 points, and that very act made the 25-point mark impossible to apply. The worse behaviour became the cheaper one — the exact inversion the migration was written to remove. Found only because the verification script's own cleanup withdrew from an already-started shift and the arithmetic didn't add up.
- Rule: when adding a penalty, enumerate every OTHER state the actor can still reach and price it. A penalty is only as strong as the cheapest alternative that avoids it — compare against the alternatives, not against zero.
- Rule: two RPCs that gate on the same row's status are coupled even when written weeks apart. Before shipping one that requires `status = X`, check what else can move that row out of X, and whether the actor controls it.
- Rule: unexpected arithmetic in test data is a signal, not noise. The reliability score landing on 43 instead of 58 is what exposed this; the temptation was to shrug at "it's only test data".

## 2026-08-14 — A test variable overwrote the anon key and every later call 401'd
- Mistake: a verification script did `A = book(S)` where `A` was already the module-level Supabase anon key. Every subsequent request sent an application UUID as the `apikey` header and got "Invalid API key" — which reads like a credentials/env problem, so I first went looking at `.env` vs `.env.local`, then dismissed it as a transient Supabase blip and re-ran. Identical code worked standalone, which should have been the tell immediately: if the same call succeeds outside the script and fails inside it, the difference is script state, not the service.
- Rule: never use single-letter names for module-level config in test scripts. Anon keys, URLs and tokens get names like `ANON_KEY`, and loop/test variables never get one-letter names that could collide.
- Rule: when an auth error appears mid-script but the same request works standalone, suspect shadowing before suspecting the service. Add a canary (`assert A == _ANON_KEY_CANARY`) rather than re-running and hoping.

## 2026-08-14 — My own guard blocked my own cleanup migration
- Mistake: 20260814 added a BEFORE DELETE guard on shifts and I deliberately did NOT exempt admins, writing at the time that "an accepted worker has a signed contract and possibly a payout entitlement, so deleting that should require deliberately cancelling first, whoever is asking." Two days later I wrote admin_purge_shift ending in `delete from public.shifts` and a one-off cleanup doing the same, forgetting the guard I had written. The whole migration rolled back on the owner.
- Rule: before writing any DELETE/UPDATE in a migration, grep for triggers on that table. `grep "on public.<table>" supabase/migrations/*.sql | grep -i trigger` takes seconds. A protection I wrote myself is still a protection I have to route around.
- Rule: when a guard is deliberately absolute (no admin exemption), the sanctioned bypass has to be designed at the same time, not retrofitted when it first gets in the way. Otherwise the first legitimate need for it arrives as a production error.
- Rule: transaction-local flags (`set_config(..., true)`) need the writes in the SAME transaction. In the Supabase SQL editor a bare sequence of statements will lose the flag between them -- wrap it in a DO block.

## 2026-08-14 — "Admin bypasses the guard" is false in the Supabase SQL editor
- Mistake: every guard I wrote this session exempts admin via `coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'`. In the SQL editor there is no JWT, so `auth.jwt()` is null and that test is FALSE. The SQL editor is a privileged *Postgres* session, which is a completely different thing from an *application* admin. I told the owner a reliability reset "works from the SQL editor because admin bypasses the guard" — it never did, and the reset silently did nothing twice before I noticed.
- Rule: `auth.jwt()`-based admin checks only work for requests arriving through PostgREST with a real admin token. Never hand the owner SQL-editor statements that depend on one. Set the guard's trusted-write flag instead, inside a DO block so the transaction-local flag survives to the write.
- Rule: guards that REASSIGN (`new.col := old.col`) fail silently — the caller sees success and no change. Guards that RAISE fail loudly. When writing a guard, prefer raising for operations a human will run by hand; and when running one by hand, verify the value afterwards rather than trusting "no error".
- Rule: this is the third self-inflicted variant of the same root cause (my own guard blocking my own maintenance). Before writing any migration that mutates a guarded column or table, list the guards on it first and decide the sanctioned path — do not discover it by failing.

## 2026-08-14 — Wrote the lesson, then broke it two migrations later
- Mistake: 20260818b recorded that `auth.jwt()` is null in the Supabase SQL editor, so admin checks of the form `auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'` are always false there. I then wrote `admin_purge_shift` gated on exactly that check and told the owner to call it from the SQL editor. It raised 'Not authorized'. Fourth instance of the same root cause in one session, and the second AFTER writing it down.
- Rule: writing a lesson does not apply it. When a lesson names a specific construct (`auth.jwt()`-based admin checks), grep the diff for that construct before handing anything over — `grep "auth.jwt()" <new migration>` would have caught this in seconds.
- Rule: an authorization check has to be written for the caller who will actually invoke it. A maintenance RPC's caller is a human in a SQL console, not an app session, so gate it on something that is true there — `current_setting('request.jwt.claims', true)` is empty for direct database sessions and always populated for PostgREST traffic.

## 2026-08-19 — Invented enum values made a guard match everything
- Mistake: `admin_purge_shift` blocked a purge while any payout was `status not in ('paid','cancelled','failed')`. None of those three is a valid `payout_item` status — the real constraint allows `queued, ready, scheduled, processed_internal, failed_internal, held`. So the NOT IN matched every row, and the guard treated every payout as outstanding, including already-paid ones. Any shift that ever generated a payout could never be purged: exactly the problem the function was written to solve. The same invented names went into cleanup SQL handed to the owner, which failed with 23514.
- Rule: never write a status/enum literal from memory. `grep "check (status in" supabase/migrations/*.sql` for the table, or query the live distinct values. This project has already drifted on `shifts.status`, `profiles.role` and `profiles.reliability_score`, so even the migration that created a table may not describe it any more — prefer the live values.
- Rule: prefer a POSITIVE list (`status in (...)`) over a negative one in guards. A typo in an IN list matches nothing and fails visibly; a typo in a NOT IN list matches everything and fails silently in the dangerous direction.
- Rule: for test rows representing money that was never owed, delete them rather than moving them to a settled status — inventing a settlement puts fiction in the payout ledger.

## 2026-08-20 — Removed a state variable, left a caller behind; browser test still "passed"
- Mistake: while replacing the cancel flow (step 4) I deleted the `lateCancelWarning` state but left `setLateCancelWarning(null)` inside `doCancelShift`. Every successful cancellation threw `ReferenceError: setLateCancelWarning is not defined` — AFTER the update had committed and the success toast had shown. My browser verification checked the DB (shift cancelled ✓), the worker notification (sent ✓) and screenshotted the UI, so it looked fine. The overnight dogfood routine caught it; I did not.
- Rule: `esbuild --bundle=false` is a SYNTAX check. It does not resolve identifiers, so a call to a deleted function passes it cleanly. Never treat "esbuild OK" as evidence that a removal was complete.
- Rule: after removing any state/variable, grep for its setter AND its getter by name and read every hit, rather than counting matches. I counted 10 and removed 10, and still missed one.
- Rule: any browser verification that clicks something must call `read_console_messages` afterwards. A crash that happens after the side effect looks identical to success from the database's point of view — which is exactly the shape of this bug.

## 2026-08-20 — Wrote an auth check on one function, not on its siblings
- Mistake: `employer_hold_for_offer` got a proper employer/admin check; `employer_release_hold` and `employer_capture_hold` got none at all, because they read to me as internal helpers called by server-side flows. They are not internal — both were `grant execute ... to authenticated`, so both were public API endpoints. Verified live with a worker's token: a worker could call either against any application. Only the absence of a hold made it harmless at that moment.
- Rule: `grant execute ... to authenticated` makes a function a public endpoint, whatever it was written for. Every such function needs its own authorization check; "it's only called from X" is a statement about intent, not about access.
- Rule: when a set of functions moves the same resource, write their auth checks together and diff them against each other before shipping. I wrote three money-movers in one file and only one could say who was allowed to call it.
- Rule: for functions meant to be called by other server-side code rather than by users, use the trusted-write session-flag idiom already established here (attendance, reliability, purge) instead of leaving them open — it keeps internal callers working without granting everyone access.

## 2026-08-20 — Translating a notification made it less accurate than the English it replaced
- Mistake: `payout_created` stores the prose "RM108.00 is on its way" and, separately, `params.amount`. jsonb stores `108.00` as the number `108`, so `RM{amount}` rendered **RM108** in all three languages. The English fallback was more precise than the translation that replaced it, and the API verification passed 8/8 without noticing — it asserted on `params` and on the stored body, both of which were correct. Only reading the rendered BM screen showed it.
- Rule: when a value moves from prose into `params`, every bit of formatting the prose had (decimals, currency, locale, timezone) must be re-applied at render time or it is silently lost. `notificationText` already did this for `*_at`; money needed the same rule and did not have it.
- Rule: verifying that `params` are correct is not verifying that the notification reads correctly. Render it — in each language — and compare against the stored English body. If the translated line says less than the fallback, the translation is a regression.
- Rule: numbers arriving from Postgres `numeric` are never display-ready. Format at the boundary, next to the existing formatting rules, so the next param type added inherits the same treatment.

## 2026-08-20 — Predicted a delete's blast radius by mixing two different units
- Mistake: before clearing the QA accounts' dead-link notifications I told the owner to expect "194 before, 135 deleted, 59 kept". The real result was 194 deleted, 0 kept. I had counted DISTINCT dead link targets (70 shift/app ids on worker1, 63 on employer2) and subtracted them from ROW counts (81, 110) — but several notifications share one link, so the two numbers were never comparable. The 59 "survivors" did not exist.
- Rule: when predicting what a DELETE will touch, count with the same predicate the DELETE uses, on rows, not on the distinct entities behind them. `select count(*) where <exact predicate>` is the only honest preview.
- Rule: an RLS-scoped count is not a schema-wide count. My survey ran on user tokens and saw 5 shifts; the SQL editor runs without RLS and sees everything. That asymmetry happened to be safe here (the script could only delete FEWER rows than my count implied), but the direction has to be reasoned about explicitly each time rather than assumed.
- Rule: state a predicted count as a prediction and reconcile it against the actual afterwards. Reporting the discrepancy is how the arithmetic error surfaced at all; quietly accepting "0 left" as success would have hidden it.

## 2026-08-20 — A fix that unblocks a delete has to say what happens to what the delete strands
- Mistake, caught before shipping: the wallet-cascade fix let a held shift be purged again. It would also have left the hold pointing at an application that no longer existed — and employer_release_hold finds a hold BY application_id, so from that moment the money was unreachable. `held` derives as (holds - releases - captures), so an orphaned hold cuts the employer's available balance forever with nothing able to reverse it. The pre-fix behaviour (purge refused outright) was LOUD and safe; the fix on its own would have traded it for silently frozen funds.
- Rule: when a change turns a refusal into a success, ask what the refusal was protecting and handle that in the SAME migration. "It now works" is not the finish line if the thing it now does is wrong.
- Rule: before deleting a row, grep for every function that LOOKS IT UP by the columns about to be nulled or dropped. A `where application_id = $1` lookup is a dependency on that row existing, whatever the FK says.

## 2026-08-20 — Verified a Postgres semantics question in a sandbox instead of production
- Approach worth repeating: the suspicion was that a referential SET NULL fires a BEFORE UPDATE trigger. Rather than reason about it, or probe the live ledger (append-only — a probe row could never have been removed), I ran `initdb` into the scratchpad, recreated just the DDL's shape, and reproduced it in a minute. Postgres names the internal statement in the error CONTEXT (`UPDATE ONLY ... SET "shift_id" = NULL`), which settles the question outright.
- The sandbox then paid for itself twice more: it proved the proposed guard allows the cascade while still refusing every real rewrite, and running the finished migration against a scaffold caught a bug in the migration's OWN self-test (it repointed shift_id using a subselect over a table it had just emptied, so it was really asserting that nulling is refused — the one update the fix deliberately permits).
- Rule: `/Library/PostgreSQL/17/bin` exists on this Mac. For any question about database semantics, or any migration whose self-test is worth trusting, spin up a throwaway cluster on a custom socket dir (the default scratchpad path exceeds the 103-byte socket limit — use `-k /tmp/<short>`) and answer it there. It costs a minute and needs nothing from the owner.

## 2026-08-20 — Scaffolded a test schema from the CREATE TABLE, not from the migrations that followed it
- Mistake: I validated a migration against a local scaffold built from `shifts`' original definition in 20260629. Production's `shifts` has since gained `shifts_occurrences_nonempty`, so the self-test's shift insert was rejected on the owner's machine and — because the SQL editor wraps the whole script in one transaction — took the perfectly good DDL down with it. Second time this session that a stale mental copy of a table caused a failure (see the stale-stub-table note in project memory).
- Rule: when scaffolding a table to test against, reconstruct it from the WHOLE migration history, not the file that created it: `grep "alter table public.<t>" -A 4 supabase/migrations/*.sql` for added columns and constraints. Five minutes of grepping beats a failed hand-over.
- Rule: an in-migration self-test must distinguish "the fix is wrong" from "the test could not build its fixtures". The first should abort the migration; the second should warn loudly and let the fix stand, because a test that is wrong about the schema is not evidence that the fix is wrong. It must still shout — an unverified fix is not a verified one.
- Rule: exercise both failure branches in the sandbox before handing over, not just the happy path. I only knew the classification worked because I forced a fake constraint violation and a fake assertion failure and watched which one rolled the DDL back.

## 2026-08-20 — Wrote a verifier whose pattern could never match, and it reported a false failure
- Mistake: the read-only check for 20260822b tested the shipped guard with `prosrc like '%new.shift_id is null or new.shift_id%'`. I typed that pattern from memory; the function actually aligns its operands (`new.shift_id       is null`), so the LIKE could not have matched no matter what the database contained. It reported "part 1 did not land" against a database where part 1 HAD landed, and sent the owner looking for a problem that did not exist.
- Rule: a verifier that cannot return true is worse than no verifier. Before handing one over, run it against a state you KNOW is good and watch it pass — I had a sandbox with the migration applied and did not use it for this.
- Rule: never write a source-matching pattern from memory. Copy the literal text out of the file, or match on whitespace-tolerant regex anchored on tokens that formatting cannot change. Alignment padding, line breaks and comments all defeat naive LIKE patterns.
- Rule: prefer catalog facts (pg_attribute.attnotnull, pg_constraint.confdeltype, pg_trigger.tgname) over prosrc matching wherever the fact is available structurally. Those four checks were right; only the two that grepped source were wrong.

## 2026-08-20 — "Check dark mode" is not a check; measurement is
- Mistake, sustained over months: STEP 3.5 of the morning routine has always said to check dark mode, and it still missed a wage figure at 3.43:1, an employer banner at 2.86:1, four landing eyebrows at 3.43:1 and an entire filter panel written in literal hex that rendered as white boxes on a dark page. The instruction was followed; it just cannot work. Amber-on-cream at 2.86:1 LOOKS fine in a screenshot, which is exactly why eyeballing certifies it.
- Rule: for any property with a computable right answer — contrast ratio, token/surface pairing, key parity across languages — write the computation, not an instruction to look. A model asked to "check" something subjective will report success.
- Rule: WCAG "large text" is >=24px, or >=18.66px when bold. 15px bold is NOT large, so 4.5:1 applies. Getting this wrong is what let the wage figure pass an earlier informal review.
- Rule: a scanner's own false positives destroy it faster than the bugs it finds. Mine first reported 14 fails including four at "ratio 1.0" because it treated `rgba(37,99,235,0.1)` as opaque; compositing the alpha layers cut it to 8, all real. Verify a new check against a state you know is good BEFORE trusting its output — and give it a baseline file, or a 99-finding legacy backlog trains everyone to ignore it.
- Rule: exemptions belong in the runbook, not in the code. WCAG 1.4.3 exempts logotypes, so the "Gaji" wordmark at 3.45:1 is not a bug — documented in STEP 3.6 rather than silently allowlisted, so the next reader learns the rule instead of inheriting a mystery.

## 2026-08-23 — A verifier that matched the wrong token passed on the broken state
- Mistake: the bundled run-all script checks that 20260809's NULL fix is in place by looking for `coalesce` in recompute_profile_rating's source. Both versions of that function contain coalesce elsewhere — `coalesce(new.ratee_id, old.ratee_id)` and `return coalesce(new, old)` — so the check passed on the UNFIXED version. It would have reported "ALL FOUR PARTS VERIFIED" against a database that had just silently lost the fix.
- Caught only because I deliberately regressed the function in a sandbox and watched the verifier wave it through. Second time in three days a check of mine could not fail; the first was a LIKE pattern that could not match, this one is a pattern that matched too much.
- Rule: a source-matching check must anchor on the construct that CHANGED, not on a word that appears in it. `set\s+rating\s*=\s*coalesce` distinguishes the two versions; `coalesce` does not. Diff the two versions and match on a line the diff actually shows.
- Rule: always run a new verifier against BOTH states — the good one and a deliberately broken one. Passing on the good state proves nothing on its own. This is now twice that the failure branch was the only thing that revealed the bug.

## 2026-08-23 — Edited a hook that does not run, then let it "prove" itself by failing open
- Mistake: added a Notion-id guard to `.git/hooks/pre-commit` and tested it by staging a file containing a real id. The commit went through — the guard was inert, because this repo sets `core.hooksPath = scripts/git-hooks`, so `.git/hooks/` is dead code. Worse, the test itself created a commit containing the very id I was trying to keep out. Unpushed, so `git reset --hard` removed it, but a second's delay and the orchestrator would have pushed it.
- Rule: before editing a git hook, run `git config core.hooksPath`. If it is set, `.git/hooks/` is not what executes. A hook under version control (as here) is the better place anyway — it ships with the repo instead of living only on one machine.
- Rule: test a guard by trying to do the thing it forbids, and check the OUTCOME (did the commit exist afterwards?), not just the output. I have now written three checks this week that could not fail; this is the first that failed silently while appearing to be installed.
- Rule: never use real secret material in a negative test. Read the value from .env into a temp file if the test genuinely needs the real string, and be ready for the test itself to become the leak — because if the guard is broken, the test IS the leak.

## 2026-08-23 — A DELETE returned 204 and deleted nothing, and I nearly reported it clean
- Mistake: cleaned up a QA application row with a REST DELETE, saw 204, and moved on. `applications` has no DELETE policy, so the request matched zero rows and reported success anyway. The row was still there; I only noticed because the same command printed the row back immediately afterwards.
- Rule: PostgREST returns 204 for a DELETE that affects no rows. 204 means "the request was valid", never "something was deleted". Always read the row back afterwards, or send `Prefer: return=representation` and check the returned array is non-empty.
- Rule: before writing test data into a REAL row's neighbourhood (an application against the owner's own live shift), work out how it will be removed FIRST. Here the answer was "only from the SQL editor", which I should have known before creating it, not after.
- Rule: leftover QA rows are not always cosmetic. This one permanently blocked that worker from ever bidding on that shift again -- via the exact unique constraint whose bug I was fixing.

## A test scaffold missing one live trigger sent a broken migration to the owner (2026-08-24)

The fee migration's self-test cleaned up with `delete from employer_wallet_entry`.
It passed locally and failed the moment the owner ran it:

    employer_wallet_entry is append-only: correct with a new entry, never by
    editing or deleting one   -- guard_wallet_entry_immutable, 20260822b

My throwaway Postgres had the ledger TABLE but not its two TRIGGERS, so the
delete succeeded locally and could never succeed live. Same root cause as the
`shifts_occurrences_nonempty` miss earlier this session, one layer deeper:
last time I rebuilt the table from CREATE TABLE and missed later constraints;
this time I remembered the constraints and missed the triggers.

RULE: a scaffold for testing a migration must be reconstructed from the
accumulated migration history INCLUDING triggers, not just tables and
constraints. Grep `create trigger` across supabase/migrations for every table
the test writes to, and port each one.

BETTER RULE, which removes the need for the first: a self-test that writes
rows should run inside a subtransaction that is ALWAYS rolled back, rather than
deleting what it made. `begin ... raise exception 'ROLLBACK_SELFTEST'; exception
when others then <re-raise real failures, swallow the sentinel> end`. It leaves
zero residue, it cannot fight an append-only guard, and it cannot leave debris
behind when an assertion fails halfway through.

Related: when restructuring a self-test's control flow, RE-RUN the deliberate
regressions. An exception handler added for cleanup can silently swallow the
very failures the test exists to raise.

## Anchor inserted hooks BELOW the state they read (4th TDZ crash, 2026-08-24)

Fourth time this session that a block inserted into a 16k-line component
referenced state declared further down, and the whole app went white with

    ReferenceError: Cannot access 'selectedShift' before initialization

The trap is that this is not a syntax error. `esbuild --bundle=false` parses it
happily, the pre-commit hook passes, and nothing surfaces until the component
actually renders. The pattern each time: I picked a textual anchor that read
well ("just above previewBanner") without checking where the referenced
`useState` actually sits.

RULE: before inserting any hook or handler into WorkerPortal / EmployerPortal /
AdminPortal, grep for the declaration of every piece of state it touches and
anchor BELOW the last one:

    grep -n 'const \[selectedShift, setSelectedShift\]' carigaji-app.jsx

RULE: after any structural insert, load the app and call
read_console_messages. A blank page with a clean build is this bug until
proven otherwise. Use the MARKER trick to tell stale buffer entries from live
ones: console.error("MARKER-x"), reload, and anything printed ABOVE the marker
is from a previous build.

## A rule that lives only in memory does not bind the routine (2026-08-27)

The evening debrief burned ~50k tokens and never sent its message. It pushed a
~2,600-char emoji-heavy body into a WebFetch URL, got a bare `Invalid URL`,
then started bisecting the message to find the length cap — and sent a stray
"test123" to the owner's real chat while probing.

The fix had been known since 2026-07-24 and was written down: project memory
says use `curl -G --data-urlencode`, that WebFetch fails exactly this way, and
"don't burn a step retrying WebFetch after that error." All three runbooks
nonetheless still said "Use WebFetch to POST to:" — and the runbook is what the
routine actually executes. Memory is context; the SKILL is the instruction.

RULE: when a lesson is about HOW A ROUTINE SHOULD ACT, put it in that
routine's SKILL.md. Memory alone is advisory and loses to an explicit
instruction sitting in front of it. Memory is for facts and history; runbooks
are for behaviour.

RULE: a failed outbound send is a one-line report, not an investigation. Never
probe a limit by sending to the owner's real chat — a stray test message at
9pm is worse than a late debrief, and the durable record (Notion) is already
written by that point.
