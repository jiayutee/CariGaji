// Supabase Edge Function: sends a real email via Resend whenever a row is
// inserted into public.notifications. Invoked directly by a Postgres
// trigger (via pg_net) rather than the Dashboard Webhooks UI — see
// supabase/migrations/20260705b_notification_email_trigger.sql. Deployed
// with --no-verify-jwt since pg_net calls aren't a normal user session；
// a shared secret header replaces JWT auth for this internal-only endpoint.
//
// Required secrets (`supabase secrets set NAME=value`):
//   RESEND_API_KEY   - from resend.com (free tier: 3,000 emails/month)
//   WEBHOOK_SECRET    - any random string; must match the one stored in
//                       Supabase Vault as 'webhook_secret' (set once via
//                       SQL Editor, see the migration file)
//   EMAIL_FROM        - e.g. "CariGaji <notifications@yourdomain.com>"
//                       (Resend requires a verified sending domain; for
//                       testing use the shared "onboarding@resend.dev")
// Auto-provided by the platform, no action needed:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "CariGaji <onboarding@resend.dev>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Friendlier subject lines per notification type (falls back to the
// notification's own title if a type isn't listed here).
const SUBJECTS: Record<string, string> = {
  shift_offer: "You've been selected for a shift on CariGaji!",
  offer_declined_or_expired: "Action needed: pick a substitute worker",
  not_selected: "Update on your CariGaji application",
  bid_accepted: "Your CariGaji bid was accepted",
  bid_rejected: "Update on your CariGaji bid",
  bid_received: "New applicant for your shift",
  shift_cancelled: "A shift you applied for was cancelled",
};

Deno.serve(async (req) => {
  try {
    // Shared-secret check in place of JWT auth (this function is deployed
    // with --no-verify-jwt so pg_net, which has no user session, can call it).
    const incomingSecret = req.headers.get("x-webhook-secret");
    if (!WEBHOOK_SECRET || incomingSecret !== WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const payload = await req.json();
    // Trigger payload shape: { record: {...new notification row...} }
    const record = payload.record ?? payload;
    const { user_id, type, title, body } = record;

    if (!user_id || !body) {
      return new Response(JSON.stringify({ skipped: true, reason: "missing user_id/body" }), { status: 200 });
    }

    // Look up the user's email via the admin API (service role required).
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(user_id);
    if (userError || !userData?.user?.email) {
      return new Response(JSON.stringify({ skipped: true, reason: "no email on file" }), { status: 200 });
    }
    const toEmail = userData.user.email;

    const subject = SUBJECTS[type] || title || "CariGaji notification";

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [toEmail],
        subject,
        html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#2563EB;">CariGaji</h2>
          <p style="font-size:15px; color:#111827;">${body}</p>
          <p style="font-size:12px; color:#6b7280; margin-top:24px;">
            You're receiving this because you have an active application or shift on CariGaji.
          </p>
        </div>`,
      }),
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      return new Response(JSON.stringify({ sent: false, error: errText }), { status: 200 });
    }

    return new Response(JSON.stringify({ sent: true, to: toEmail }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});

/*
 * SETUP (one-time, owner action) — see supabase/migrations/20260705b_notification_email_trigger.sql
 * for the pg_net trigger that calls this function (no Dashboard Webhooks UI needed):
 * 1. Create a free account at https://resend.com and grab an API key.
 * 2. Pick any random string as your webhook secret, e.g. generate one with:
 *      openssl rand -hex 32
 * 3. supabase secrets set RESEND_API_KEY=re_xxx
 *    supabase secrets set WEBHOOK_SECRET=<the random string from step 2>
 * 4. supabase functions deploy send-notification-email --no-verify-jwt
 * 5. In Supabase SQL Editor, store that SAME random string in Vault (never
 *    commit this command to git — run it directly in the dashboard):
 *      select vault.create_secret('<the random string from step 2>', 'webhook_secret');
 * 6. Run supabase/migrations/20260705b_notification_email_trigger.sql — it
 *    creates the trigger that calls this function on every new notification.
 * 7. (Optional but recommended) verify your own sending domain in Resend
 *    and set EMAIL_FROM to an address on it, instead of the shared
 *    onboarding@resend.dev sender, which has stricter rate limits.
 */
