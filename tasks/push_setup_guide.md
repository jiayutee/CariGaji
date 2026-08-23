# Turning on phone notifications — VAPID setup

Everything in the app is built and shipped. It stays **dormant** until these
keys exist: with no key, `pushSupported()` returns false, the Settings row says
"Not available in this browser", and users keep getting email. Nothing breaks
while this sits undone.

VAPID is just an identity for your server. The push services (Google's FCM for
Chrome, Mozilla's for Firefox) want to know who is sending, so you sign each
push with a private key and they check it against the public one. There is
nothing to sign up for and nothing to pay.

---

## 1. Generate the pair (30 seconds)

```bash
npx web-push generate-vapid-keys
```

Output looks like:

```
Public Key:
BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U

Private Key:
UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls
```

**Public key** — safe to publish. It ships inside the JavaScript bundle by
design; anyone can read it and it lets them do nothing.

**Private key** — treat like a password. Anyone holding it can send push
notifications that appear to come from CariGaji. It never goes in the repo.

> If you ever regenerate the pair, **every existing subscription stops working**
> and every user has to turn notifications on again. Generate once, keep it.

---

## 2. Give the private key to Supabase

```bash
supabase secrets set VAPID_PUBLIC_KEY=BEl62iUYgUivxIkv...
supabase secrets set VAPID_PRIVATE_KEY=UUxI4O8-FbRouAevSmBQ...
supabase secrets set VAPID_SUBJECT=mailto:your-email@example.com
supabase functions deploy send-push
```

`VAPID_SUBJECT` is a contact address the push services use if something goes
wrong with your sending. Any mailto: or https: URL you actually read.

No Supabase CLI? Dashboard → Edge Functions → `send-push` → Secrets does the
same thing, and the function can be deployed by pasting
`supabase/functions/send-push/index.ts`.

---

## Where each key goes — the part that trips people up

| what | where | why |
|---|---|---|
| Private key | Supabase Edge Function secrets | signs each push; must never reach a browser |
| Public key | Supabase secrets **and** GitHub secret | the browser hands it to Chrome when subscribing, so it must be in the bundle |
| Neither | the webhook form | the webhook only names a table and a function |

Put the private key in the GitHub secret by mistake and it ends up in published
JavaScript. If that happens: regenerate the pair, and everyone who had enabled
notifications must turn them on again.

## 3. Give the public key to the app

**Local development** — add to `.env.local`:

```
VITE_VAPID_PUBLIC_KEY=BEl62iUYgUivxIkv...
```

**Production** — GitHub → Settings → Secrets and variables → Actions → New
repository secret:

```
Name:   VITE_VAPID_PUBLIC_KEY
Value:  BEl62iUYgUivxIkv...
```

The deploy workflow already passes it through; it needs no edit. The next push
to `main` rebuilds with the key baked in.

---

## 4. Point the webhook at the function

Supabase **moved this out of Database into Integrations**. Direct link:

    https://supabase.com/dashboard/project/eqxpskyymohghxgtykfr/integrations/webhooks/overview

Or: sidebar → Integrations → Database Webhooks → *Enable webhooks* (first time
only) → **Create a new hook**. If it has moved again, the dashboard's search box
finds it faster than the sidebar does.

| field | value |
|---|---|
| Name | `send_push_on_notification` |
| Schema / Table | `public` / `notifications` |
| Events | Insert only |
| Type of webhook | Supabase Edge Functions |
| Edge Function | `send-push` |
| Method | POST |
| Timeout | 5000 ms |
| HTTP Headers | leave as-is — the dashboard fills in the auth header |

**No VAPID key goes in this form.** The webhook only says "call this function
when a row is inserted". The keys live in step 2 (Supabase secrets) and step 3
(the GitHub secret). Nothing in the webhook needs to know about them.

Worth checking while you are here: whether a hook for `send-notification-email`
exists at all. That function has been in the repo a while but the hook has never
been confirmed. Webhooks are ordinary triggers, so this lists what is really
wired up:

```sql
select tgname, pg_get_triggerdef(oid)
from pg_trigger
where tgrelid = 'public.notifications'::regclass and not tgisinternal;
```

If `send-notification-email` is not in that list, emails are not being sent
either -- worth knowing regardless of push.

**Leave the existing `send-notification-email` hook alone.** Both fire on the
same insert, independently: email reaches iPhone users in a Safari tab where
Web Push cannot go, and push reaches people who never open their inbox.

---

## 5. Check it works

1. Open the site in Chrome on Android or desktop, sign in
2. Settings → Phone notifications → **Turn on** → allow at the browser prompt
3. Confirm the device registered:
   ```sql
   select user_id, left(endpoint, 60) as endpoint, created_at
   from public.push_subscriptions order by created_at desc limit 5;
   ```
4. Trigger a real notification — have someone bid on your shift, or insert one
   by hand:
   ```sql
   insert into public.notifications (user_id, type, title, body, link)
   values ('<your-user-id>', 'bid_received', 'Test', 'Push is working.', '/employer/shifts/x');
   ```
5. It should appear in the OS tray within a second or two, even with the tab
   closed. Tapping focuses the app.

If nothing arrives, Dashboard → Edge Functions → `send-push` → Logs shows one
line per attempt: `{"sent":1}`, or `{"skipped":true,"reason":"..."}` naming
exactly what was missing.

---

## What to expect

| | works? |
|---|---|
| Android — Chrome, Firefox, Edge | yes, in a normal tab |
| Desktop — Chrome, Firefox, Edge | yes |
| Desktop Safari | yes |
| **iPhone / iPad** | only after "Add to Home Screen" |

iOS has supported Web Push since 16.4, but only for an installed site — in a
Safari tab there is no push and no way to ask. That is why email stays.

Two behaviours worth knowing:

- **A denied permission is sticky.** Chrome will not ask twice; the user has to
  go into site settings to undo it. That is why the app asks only when the user
  taps "Turn on", never on load.
- **Push text is English**, even for a BM or Chinese reader. The service worker
  runs outside the app and cannot reach its translation table. Tapping through
  lands on the in-app notification, which IS translated. Fixing this properly
  means storing each user's language and rendering server-side — worth doing
  later, not a blocker now.
