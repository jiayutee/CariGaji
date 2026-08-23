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
//   VAPID_SUBJECT      OPTIONAL. Contact URL or mailto: for your service.
//                      Falls back to the GitHub Pages URL -- valid and real --
//                      so push works without a domain or support inbox.
// Auto-provided by the platform:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
// Required by the VAPID spec so a push service can reach the sender if the
// notifications cause a problem. NOT produced by `web-push generate-vapid-keys`
// -- it is chosen -- and unlike the keys it can be changed later without
// invalidating a single subscription.
//
// The default is this project's own GitHub Pages URL rather than a mailto: at a
// domain nobody has registered. An https: subject is equally valid, and
// pointing at a page we control is honest; naming carigaji.app would claim a
// domain belonging to someone else. Replace with mailto:support@<real domain>
// once that exists.
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "https://jiayutee.github.io/CariGaji/";
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

    // Two webhooks feed this function, because two different things are worth
    // waking a phone for and they live in different tables.
    //
    // A chat message does NOT create a notifications row -- nothing in the
    // schema does that -- so a webhook on notifications alone left chat
    // completely silent, which is what the owner hit. Rather than making every
    // chat message insert a notification (which would fill the bell and send an
    // email per message), the messages table gets its own hook straight to
    // push.
    const isMessage = payload.table === "messages" || (record.shift_id && record.content);

    let recipients: string[] = [];
    let title = "";
    let body = "";
    let link = "/CariGaji/";

    if (isMessage) {
      // Group room: recipient_id is null and everyone in the room should hear
      // about it except whoever sent it. A legacy 1:1 row (recipient_id set)
      // goes only to that person.
      if (!record.shift_id || !record.content) {
        return new Response(JSON.stringify({ skipped: true, reason: "message missing shift_id/content" }), { status: 200 });
      }

      if (record.recipient_id) {
        recipients = [record.recipient_id];
      } else {
        const { data: shift } = await supabaseAdmin
          .from("shifts").select("employer_id, title").eq("id", record.shift_id).maybeSingle();
        const { data: apps } = await supabaseAdmin
          .from("applications").select("worker_id").eq("shift_id", record.shift_id).eq("status", "accepted");
        recipients = [shift?.employer_id, ...(apps || []).map((a: { worker_id: string }) => a.worker_id)]
          .filter((id): id is string => Boolean(id) && id !== record.sender_id);
        link = "/CariGaji/";
        title = shift?.title ? `New message · ${shift.title}` : "New message";
      }

      const { data: sender } = await supabaseAdmin
        .from("profiles").select("full_name").eq("id", record.sender_id).maybeSingle();
      const who = sender?.full_name || "Someone";
      if (!title) title = "New message";
      const text = String(record.content);
      body = `${who}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
    } else {
      if (!record.user_id || !record.body) {
        return new Response(JSON.stringify({ skipped: true, reason: "missing user_id/body" }), { status: 200 });
      }
      recipients = [record.user_id];
      title = record.title || "CariGaji";
      body = record.body;
      link = record.link ? `/CariGaji${record.link}` : "/CariGaji/";
    }

    // Deduplicate: the same person can be both employer and an accepted worker
    // on a test shift, and would otherwise get two copies.
    recipients = [...new Set(recipients)];
    if (!recipients.length) {
      return new Response(JSON.stringify({ sent: 0, reason: "no recipients" }), { status: 200 });
    }

    const { data: subs, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("user_id", recipients);

    if (error) {
      return new Response(JSON.stringify({ sent: 0, error: error.message }), { status: 200 });
    }
    if (!subs?.length) {
      return new Response(JSON.stringify({ sent: 0, reason: "no devices registered" }), { status: 200 });
    }

    // English prose, not a translated string -- the service worker cannot reach
    // the app's TRANSLATIONS table. Tapping through lands in the app, where
    // everything IS rendered in the reader's language.
    const message = JSON.stringify({
      title,
      body,
      link,
      // One tag per room (or per notification) so a burst of chat messages
      // replaces itself in the tray instead of stacking ten deep.
      tag: isMessage ? `chat-${record.shift_id}` : (record.link || `notification-${record.id ?? ""}`),
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
 * 4. Supabase Dashboard -> Integrations -> Database Webhooks. (Not under
 *    Database any more -- Supabase moved it.) Create TWO hooks, both pointing
 *    at send-push:
 *
 *      a) Table: notifications | Events: Insert   -- offers, payouts, cancellations
 *      b) Table: messages      | Events: Insert   -- chat
 *
 *    (b) is not optional if chat should reach a phone. Nothing in the schema
 *    inserts a notifications row when a message is sent, so a hook on
 *    notifications alone leaves chat silent -- push, email and the bell all.
 *
 *    Chat deliberately does NOT go through the notifications table: that would
 *    put every message in the bell and send an email for each one. It goes
 *    straight to push instead, and the in-app chat badge covers the rest.
 *
 *    Leave the existing send-notification-email hook on notifications in place.
 */
