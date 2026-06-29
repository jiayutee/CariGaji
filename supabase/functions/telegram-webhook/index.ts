import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN   = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID     = 51218456;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

const tg = (method: string, body: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const reply = (text: string) =>
  tg("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "Markdown" });

const HELP = `🤖 *CariGaji Bot commands:*

• *build shifts* — approve shifts DB + UI
• *skip* — skip current blocked task
• *pause* — halt work loop
• *resume* — resume work loop
• *status* — get live progress report
• *priority: [task]* — bump task to Priority 5
• *help* — show this message

Commands execute at the start of the next work cycle (every 2h).`;

Deno.serve(async (req) => {
  // Validate Telegram webhook secret header
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return new Response("OK");

  const fromId = (message.chat as Record<string, unknown>)?.id;
  const text   = ((message.text as string) ?? "").trim().toLowerCase();

  // Only accept messages from the owner's chat
  if (fromId !== CHAT_ID) {
    await reply("⛔ Unauthorised.");
    return new Response("OK");
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Instant-reply commands ──────────────────────────────────────────────

  if (text === "help" || text === "/help") {
    await reply(HELP);
    return new Response("OK");
  }

  if (text === "status" || text === "/status") {
    const { data: pending } = await supabase
      .from("bot_commands")
      .select("command, created_at")
      .eq("processed", false)
      .order("created_at", { ascending: true });

    const { data: kycPending } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("kyc_level", "pending_review");

    const queuedCmds = pending?.map(c => `• ${c.command}`).join("\n") || "None";
    const kycCount   = (kycPending as unknown as { count: number })?.count ?? "?";

    await reply(
      `📊 *CariGaji Status*\n\n` +
      `🔁 Queued commands:\n${queuedCmds}\n\n` +
      `👤 KYC pending review: ${kycCount}\n\n` +
      `_Work loop runs every 2h. Commands execute next cycle._`
    );
    return new Response("OK");
  }

  // ── Deferred commands (queued for orchestrator) ─────────────────────────

  const DEFERRED: Record<string, { command: string; ack: string }> = {
    "build shifts":   { command: "build_shifts",   ack: "✅ *build shifts* queued!\nI'll design the DB schema + employer posting UI next cycle. 🏗️" },
    "approve schema": { command: "build_shifts",   ack: "✅ *build shifts* queued!\nI'll design the DB schema + employer posting UI next cycle. 🏗️" },
    "skip":           { command: "skip",            ack: "⏭️ *skip* queued!\nI'll move to the next task next cycle." },
    "pause":          { command: "pause",           ack: "⏸️ *pause* queued!\nWork loop will halt at the start of next cycle." },
    "resume":         { command: "resume",          ack: "▶️ *resume* queued!\nWork loop will resume next cycle." },
  };

  // priority: [task name]
  if (text.startsWith("priority:")) {
    const args = text.replace("priority:", "").trim();
    if (args) {
      await supabase.from("bot_commands").insert({ command: "priority", args });
      await reply(`⬆️ *priority: ${args}* queued!\nI'll bump that task to Priority 5 next cycle.`);
      return new Response("OK");
    }
  }

  const deferred = DEFERRED[text];
  if (deferred) {
    // Upsert so duplicate commands don't stack
    await supabase
      .from("bot_commands")
      .upsert({ command: deferred.command, processed: false }, { onConflict: "command" })
      .eq("processed", false);
    await reply(deferred.ack);
    return new Response("OK");
  }

  // Unknown command
  await reply(`🤔 Unknown command: *${text}*\n\nSend *help* to see what I understand.`);
  return new Response("OK");
});
