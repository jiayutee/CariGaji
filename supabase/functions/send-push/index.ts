// Supabase Edge Function: sends a Web Push notification to every device a user
// has registered, whenever a row is inserted into public.notifications.
//
// Invoked by the SAME Database Webhook mechanism as send-notification-email
// (Database -> Webhooks, on notifications INSERT). The two are independent:
// email reaches iPhone users in a Safari tab, where Web Push cannot go, and
// push reaches people who have not opened their inbox. Neither depends on the
// other, and a failure in one must not break the other.
//
// Required secrets (`supabase secrets set NAME=value`):
//   VAPID_PUBLIC_KEY   the same key the client ships as VITE_VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY  its pair -- server only, never in the bundle
//   VAPID_SUBJECT      a contact URL or mailto: for your service, e.g.
//                      "mailto:support@carigaji.example"
// Auto-provided by the platform:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@carigaji.app";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

Deno.serve(async (req) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      // Loud but non-fatal: the webhook also drives the email function, and
      // returning an error status would make the whole delivery look broken.
      return new Response(JSON.stringify({ skipped: true, reason: "VAPID keys not configured" }), { status: 200 });
    }

    const payload = await req.json();
    const record = payload.record ?? payload;
    const { user_id, title, body, link } = record;

    if (!user_id || !body) {
      return new Response(JSON.stringify({ skipped: true, reason: "missing user_id/body" }), { status: 200 });
    }

    const { data: subs, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", user_id);

    if (error) {
      return new Response(JSON.stringify({ sent: 0, error: error.message }), { status: 200 });
    }
    if (!subs?.length) {
      return new Response(JSON.stringify({ sent: 0, reason: "no devices registered" }), { status: 200 });
    }

    // The stored English prose, not a translated string -- the service worker
    // cannot reach the app's TRANSLATIONS table. Tapping through lands on the
    // in-app notification, which IS rendered in the reader's language.
    const message = JSON.stringify({
      title: title || "CariGaji",
      body,
      link: link ? `/CariGaji${link}` : "/CariGaji/",
      tag: link || `notification-${record.id ?? ""}`,
    });

    const results = await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message,
        );
        return { id: sub.id, ok: true };
      } catch (e) {
        // 404/410 mean the browser threw the subscription away -- the app was
        // uninstalled, or the user cleared site data. Keeping the row would
        // mean retrying a dead endpoint on every future notification forever,
        // so it is removed on the spot. Any other failure is transient and the
        // row is left alone.
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await supabaseAdmin.from("push_subscriptions").delete().eq("id", sub.id);
          return { id: sub.id, ok: false, pruned: true };
        }
        return { id: sub.id, ok: false, error: String(e) };
      }
    }));

    return new Response(JSON.stringify({
      sent: results.filter(r => r.ok).length,
      pruned: results.filter(r => (r as { pruned?: boolean }).pruned).length,
      failed: results.filter(r => !r.ok && !(r as { pruned?: boolean }).pruned).length,
    }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});

/*
 * SETUP (one-time, owner action):
 *
 * 1. Generate a VAPID key pair. Either:
 *      npx web-push generate-vapid-keys
 *    or in a browser console on any page:
 *      crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"}, true, ["sign","verify"])
 *    The pair is: a PUBLIC key (safe to ship in the bundle) and a PRIVATE key
 *    (server only -- if it leaks, anyone can push to your users; regenerate
 *    and every existing subscription becomes invalid).
 *
 * 2. Server side:
 *      supabase secrets set VAPID_PUBLIC_KEY=BOh...
 *      supabase secrets set VAPID_PRIVATE_KEY=xxx
 *      supabase secrets set VAPID_SUBJECT=mailto:you@yourdomain
 *      supabase functions deploy send-push
 *
 * 3. Client side: put the PUBLIC key only in .env as
 *      VITE_VAPID_PUBLIC_KEY=BOh...
 *    and add it as a repository secret + a `env:` entry in the Pages workflow,
 *    so the deployed bundle has it. Without it, pushSupported() returns false
 *    and the app quietly falls back to email -- no errors, no broken toggle.
 *
 * 4. Supabase Dashboard -> Database -> Webhooks -> Create a new hook
 *      Table: notifications | Events: Insert
 *      Type: Supabase Edge Functions | Function: send-push
 *    (Leave the existing send-notification-email hook in place; both fire.)
 */
