// Workflow script — the "verify/commit slice" of the orchestrator loop.
//
// Called from SKILL.md's STEP 4, ONLY when
// /Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/pipeline_enabled.txt
// exists — that flag file is the on/off switch for this path; its absence
// runs SKILL.md's legacy path (specialist routing decided in prose) instead.
// Delete the flag file at any time to fall straight back to legacy behavior.
//
// Replaces STEP 4-7's old shape (execute -> build gate -> commit/push ->
// Notion update -> deploy) with deterministic control flow and
// schema-validated agent output, for the class of bug that recurs when
// those steps are prose an LLM has to remember to follow every 2-hour
// cycle: a silent no-op Notion write, a turn-limit truncation misread as a
// clean review, a build gate skipped under turn pressure.
//
// STEP 0-3 (Telegram intake, ambiguity handling, agenda pick, risk
// classification) stay OUTSIDE this script on purpose -- those need an
// LLM's judgment on unstructured input, not a fixed pipeline shape.
//
// Design notes carried from review (kept short; the full discussion is in
// the PR/commit history if the reasoning behind any of these is unclear):
//   - Feature Backlog Status+Date coupling is mechanized in the Notion
//     phase (write both in one call, re-verify both) — this is the rule
//     that produced a measured 38% defect rate when it lived only in prose.
//   - A Planner pass runs first for args.task.multiFile, restoring the
//     original >1-file routing.
//   - Implement/Verify/Build-Gate is a bounded, context-carrying retry loop
//     (default 2 attempts via args.maxAttempts), not a single blind redo.
//   - Cost per landed item is genuinely higher than one inline session;
//     that's real and unsolved here — the flag-gate above is what makes
//     that observable before it runs unattended by default.
//   - scripts/orchestrator-watch.py recognizes this tool's call/result pair
//     directly, so these stages show up in the live dashboard.

export const meta = {
  name: 'carigaji-verify-commit',
  description: 'Land one agenda item: (plan) -> implement -> verify -> build-gate -> merge/push -> Notion confirm -> deploy-check',
  phases: [
    { title: 'Plan', detail: 'planner pass — only for multi-file tasks' },
    { title: 'Implement', detail: 'feature-dev or debugger, isolated in a worktree' },
    { title: 'Verify', detail: 'code-reviewer (+ security-reviewer if risk >= medium) on the diff' },
    { title: 'Build Gate', detail: 'esbuild syntax check before anything lands on main' },
    { title: 'Land', detail: 'merge the worktree branch into main and push' },
    { title: 'Notion', detail: 'Daily Log commit-hash write + Backlog Status/Date write, both re-fetched to confirm' },
    { title: 'Deploy', detail: 'force a Pages publish and confirm the live site changed' },
  ],
}

// ── quick-patch knobs [ADDRESSED: 6] ───────────────────────────────────────
// The rules most likely to need a same-day fix after an incident, as named
// constants instead of buried in prompt strings — editing one of these is
// the same motion as editing a SKILL.md paragraph, just scoped to one line.
const BUILD_GATE_CMD = 'npx esbuild carigaji-app.jsx --bundle=false --platform=browser > /dev/null'
const NOTION_WRITE_RULES =
  'Fetch and concatenate existing fields before writing — never overwrite a growing field. ' +
  'A rich_text field over ~2000 chars in one element will 400 — split across elements. ' +
  'update_properties wants plain string/number/null values, never a nested {select:{name}} object.'
const DEFAULT_MAX_ATTEMPTS = 2

// ── schemas ────────────────────────────────────────────────────────────────
// Forcing structured output is the actual fix for "a subagent's free-text
// summary read like an approval but the work was truncated" — a schema
// can't be skimmed past the way a paragraph can.

const PLAN_SCHEMA = {
  type: 'object',
  required: ['files', 'plan'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    plan: { type: 'string' },
    risks: { type: 'string' },
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['worktreePath', 'branch', 'filesChanged', 'summary'],
  properties: {
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['blocking', 'findings'],
  properties: {
    blocking: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          file: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
}

const BUILD_GATE_SCHEMA = {
  type: 'object',
  required: ['passed'],
  properties: { passed: { type: 'boolean' }, error: { type: 'string' } },
}

const LAND_SCHEMA = {
  type: 'object',
  // commitHash is required, not optional. With `pushed` alone, an agent that
  // reported success without a hash produced "commit undefined" in the Daily
  // Log -- and the verify step then confirmed that the string "undefined" was
  // present and called the write good. A check that certifies its own
  // corruption is worse than no check.
  required: ['pushed', 'commitHash'],
  properties: {
    pushed: { type: 'boolean' },
    commitHash: { type: 'string' },
    error: { type: 'string' },
  },
}

const NOTION_SCHEMA = {
  type: 'object',
  required: ['written', 'verified'],
  properties: { written: { type: 'boolean' }, verified: { type: 'boolean' } },
}

const DEPLOY_SCHEMA = {
  type: 'object',
  required: ['live'],
  properties: { live: { type: 'boolean' } },
}

// ── args ─────────────────────────────────────────────────────────────────
// args = {
//   task: {
//     name, intent: 'implement'|'debug', riskLevel: 'low'|'medium'|'high', description,
//     multiFile: boolean,   // run a Planner pass first [ADDRESSED: 2]
//   },
//   maxAttempts: number,    // default 2 [ADDRESSED: 3]
//   notion: {
//     dailyLogPageId,               // optional — Daily Log Done-Today write
//     backlogRowId, completionDate, // optional — Backlog Status+Date write [ADDRESSED: 1]
//   },
// }
// completionDate must be passed in (YYYY-MM-DD, the day the work actually
// lands) — Workflow scripts can't call Date.now()/new Date() themselves,
// so the caller (which can read the real clock) supplies it.

const task = args && args.task
if (!task || !task.name) {
  throw new Error('carigaji-verify-commit requires args.task.{name,intent,riskLevel,description}')
}
const notionCfg = args.notion || {}
const MAX_ATTEMPTS = args.maxAttempts || DEFAULT_MAX_ATTEMPTS

log(`Landing agenda item: ${task.name} (${task.intent}, risk=${task.riskLevel}, maxAttempts=${MAX_ATTEMPTS})`)

// ── Plan (only for multi-file tasks) [ADDRESSED: 2] ────────────────────────
let plan = null
if (task.multiFile) {
  phase('Plan')
  plan = await agent(
    `Task: ${task.name}\nDescription: ${task.description}\n` +
      `Working directory: /Users/jiayutee/Dev/Projects/CariGaji\n` +
      `Produce a scope plan for this multi-file change: which files need to change and why, plus any risks.`,
    { agentType: 'planner', schema: PLAN_SCHEMA, phase: 'Plan' }
  )
}

// ── Implement / Verify / Build Gate, retried with real context [ADDRESSED: 3] ─
// Bounded, not open-ended (that's the cost tradeoff in disadvantage 4) —
// but each retry carries the SPECIFIC prior failure forward, so it's a
// second real attempt at the actual problem, not a blind redo.
const implementer = task.intent === 'debug' ? 'debugger' : 'feature-dev'
let attempt = 0
let impl = null
let allFindings = []
let priorFailure = null
let succeeded = false

while (attempt < MAX_ATTEMPTS && !succeeded) {
  attempt++
  log(`Attempt ${attempt}/${MAX_ATTEMPTS}`)

  phase('Implement')
  const planContext = plan
    ? `\nPlan from the planning pass — files: ${plan.files.join(', ')}. Plan: ${plan.plan}` +
      `${plan.risks ? '. Risks: ' + plan.risks : ''}`
    : ''
  const failureContext = priorFailure
    ? `\nThe previous attempt failed at "${priorFailure.stage}": ${priorFailure.reason}. ` +
      `Fix that specific problem — do not just redo the same thing.`
    : ''
  impl = await agent(
    `Task: ${task.name}\nDescription: ${task.description}${planContext}${failureContext}\n` +
      `Working directory: /Users/jiayutee/Dev/Projects/CariGaji\n` +
      `Implement this change (if intent is debug: isolate root cause, then fix it). ` +
      `Never hardcode hex colors — use BRAND theme tokens. ` +
      `Return worktreePath (your cwd), branch (your current branch), filesChanged, and a one-paragraph summary.`,
    { agentType: implementer, isolation: 'worktree', schema: IMPLEMENT_SCHEMA, phase: 'Implement' }
  )

  if (!impl) {
    priorFailure = { stage: 'implement', reason: 'implementer agent produced no result' }
    continue
  }

  phase('Verify')
  const reviewerTypes = ['code-reviewer']
  if (task.riskLevel !== 'low') reviewerTypes.push('security-reviewer')

  const reviews = (
    await parallel(
      reviewerTypes.map((r) => () =>
        agent(
          `Review the diff in worktree ${impl.worktreePath} (branch ${impl.branch}) against main. ` +
            `Files changed: ${impl.filesChanged.join(', ')}. Context: ${task.description}\n` +
            `Set blocking=true only for a real correctness/security defect, not style nits.`,
          { agentType: r, schema: REVIEW_SCHEMA, phase: 'Verify', label: `verify:${r}:attempt${attempt}` }
        )
      )
    )
  ).filter(Boolean)

  allFindings = reviews.flatMap((r) => r.findings || [])
  if (reviews.some((r) => r.blocking)) {
    priorFailure = { stage: 'verify', reason: 'reviewer blocked', findings: allFindings }
    continue
  }

  phase('Build Gate')
  const gate = await agent(
    // No punctuation after the command, and the path quoted. A period landing
    // on `> /dev/null.` turns the null device into a file path, which on macOS
    // is a permission error in / -- the gate would then report a build failure
    // that never happened and stall every cycle.
    `Run exactly this, and nothing else:\n\n    cd "${impl.worktreePath}" && ${BUILD_GATE_CMD}\n\n` +
      `Report passed=true only if that command exits 0. On failure, capture the error text verbatim.`,
    { agentType: 'test-runner', schema: BUILD_GATE_SCHEMA, phase: 'Build Gate' }
  )

  if (!gate || !gate.passed) {
    priorFailure = { stage: 'build-gate', reason: gate ? gate.error : 'no result' }
    continue
  }

  succeeded = true
}

if (!succeeded) {
  log(`Gave up after ${attempt} attempt(s) at "${priorFailure.stage}": ${priorFailure.reason}`)
  return {
    landed: false,
    stage: priorFailure.stage,
    reason: priorFailure.reason,
    findings: priorFailure.findings || allFindings,
    attempts: attempt,
    worktreePath: impl ? impl.worktreePath : undefined,
  }
}

// ── Land: merge the worktree branch into main and push ────────────────────
phase('Land')
const land = await agent(
  `In /Users/jiayutee/Dev/Projects/CariGaji: git fetch origin, then merge branch ${impl.branch} ` +
    `(from worktree ${impl.worktreePath}) into main with a commit message describing "${task.name}", ` +
    `including the standard Co-Authored-By trailer. Push origin main. Only after the push succeeds, ` +
    `remove the worktree (git worktree remove ${impl.worktreePath}). ` +
    `Report pushed=true with the resulting commit hash, or pushed=false with the error — ` +
    `do not remove the worktree if the push failed.`,
  { agentType: 'feature-dev', schema: LAND_SCHEMA, phase: 'Land' }
)

if (!land || !land.pushed) {
  log(`Push failed: ${land ? land.error : 'no result'}`)
  return { landed: false, stage: 'land', reason: land ? land.error : 'no result', attempts: attempt, worktreePath: impl.worktreePath }
}

// Belt as well as braces: the schema now demands a hash, but a validator can
// be bypassed by a retry path or a future edit, and everything downstream
// writes this value into Notion. Refuse rather than record nonsense.
if (!/^[0-9a-f]{7,40}$/i.test(String(land.commitHash || ''))) {
  log(`Push reported success but returned no usable commit hash: ${land.commitHash}`)
  return {
    landed: false, stage: 'land',
    reason: `pushed=true but commitHash was ${JSON.stringify(land.commitHash)}`,
    attempts: attempt, worktreePath: impl.worktreePath,
  }
}

log(`Pushed ${land.commitHash}`)

// ── Notion: Daily Log write, then Backlog Status+Date write ────────────────
// Both writes follow the same shape: write, then re-fetch to prove it
// actually persisted, then retry once if it didn't. Never trust the write
// call's own success response as proof — that trust is what silently no-op'd
// 4 times in the current implementation.
phase('Notion')

let dailyLog = { written: false, verified: false }
if (notionCfg.dailyLogPageId) {
  dailyLog = await agent(
    `Append to today's Daily Log page (id ${notionCfg.dailyLogPageId}): Done Today gets ` +
      `"${task.name} — commit ${land.commitHash}". ${NOTION_WRITE_RULES} ` +
      `Then re-fetch the page and confirm "${land.commitHash}" now appears in its Commits property. ` +
      `written=true only means the write call succeeded; verified=true only if the re-fetch shows the hash.`,
    { schema: NOTION_SCHEMA, phase: 'Notion', label: 'daily-log' }
  )
  if (!dailyLog || !dailyLog.verified) {
    log('Daily Log write did not verify on first attempt — retrying once.')
    dailyLog = await agent(
      `Re-fetch today's Daily Log page (id ${notionCfg.dailyLogPageId}). If "${land.commitHash}" is still ` +
        `missing from its Commits property, write it (concatenating, never overwriting) and re-fetch once ` +
        `more to confirm.`,
      { schema: NOTION_SCHEMA, phase: 'Notion', label: 'daily-log-retry' }
    )
  }
} else {
  log('No Daily Log page id supplied — skipping Daily Log write.')
}

// [ADDRESSED: 1] The rule the first draft left out — Status and Date of
// Completion move together, in ONE call, always re-verified together. This
// is the specific gap that produced a measured 38% defect rate (45 of 118
// Done rows missing a completion date) when it was enforced only by prose.
let backlog = { written: false, verified: false }
if (notionCfg.backlogRowId) {
  if (!notionCfg.completionDate) {
    log('backlogRowId given without completionDate — skipping the Backlog write rather than guessing a date.')
  } else {
    backlog = await agent(
      `Update Feature Backlog row ${notionCfg.backlogRowId} in ONE notion-update-page call: set Status to ` +
        `"Done" AND Date of Completion to "${notionCfg.completionDate}" together — never one without the ` +
        `other. ${NOTION_WRITE_RULES} Then re-fetch the row and confirm BOTH fields actually took. ` +
        `written=true only if the call succeeded; verified=true only if the re-fetch shows BOTH ` +
        `Status=Done and Date of Completion=${notionCfg.completionDate}.`,
      { schema: NOTION_SCHEMA, phase: 'Notion', label: 'backlog-status-date' }
    )
    if (!backlog || !backlog.verified) {
      log('Backlog Status+Date write did not verify on first attempt — retrying once.')
      backlog = await agent(
        `Re-fetch Feature Backlog row ${notionCfg.backlogRowId}. If Status and Date of Completion aren't ` +
          `BOTH set correctly, write both together again (never one alone) and re-fetch once more to confirm.`,
        { schema: NOTION_SCHEMA, phase: 'Notion', label: 'backlog-status-date-retry' }
      )
    }
  }
}

// ── Deploy check ───────────────────────────────────────────────────────────
phase('Deploy')
const deploy = await agent(
  // Two fixes here. The command no longer ends in a period for the same reason
  // as the build gate. And it checks CLOUDFLARE, not just Pages: as of
  // 2026-08-27 carigaji.jiayutee.workers.dev is the host that serves deep
  // links with a real 200 and is the one search engines see. Confirming only
  // github.io would have reported a healthy deploy while the primary host was
  // stale.
  `Sleep 60 seconds, then run exactly:\n\n    gh api -X POST repos/jiayutee/CariGaji/pages/builds\n\n` +
    `Then fetch BOTH live hosts and confirm each reflects this change: ${impl.summary}\n` +
    `    curl -s https://carigaji.jiayutee.workers.dev/\n` +
    `    curl -s https://jiayutee.github.io/CariGaji/\n` +
    `Cloudflare is the primary host; report live=true only if IT confirms the change. ` +
    `If Cloudflare is updated but GitHub Pages is not, still report live=true and say so in the note.`,
  { schema: DEPLOY_SCHEMA, phase: 'Deploy' }
)

return {
  landed: true,
  commitHash: land.commitHash,
  attempts: attempt,
  notionVerified: !!(dailyLog && dailyLog.verified),
  backlogVerified: notionCfg.backlogRowId ? !!(backlog && backlog.verified) : null,
  deployLive: !!(deploy && deploy.live),
  findings: allFindings,
}
