// Сообщает главному админу в Telegram, что владелец компании написал в поддержку.
// Вызывается триггером базы сразу после сообщения и из pg_cron раз в 5 минут как страховка.
// Нужны секреты: TELEGRAM_ADMIN_BOT_TOKEN (токен бота) и TELEGRAM_ADMIN_CHAT_ID (ваш чат с этим ботом).
import { safeEqual } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!expected || !safeEqual(given, expected)) return json({ error: "forbidden" }, 401);

  const token = Deno.env.get("TELEGRAM_ADMIN_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID");
  // Telegram не настроен: сообщения остаются не отмеченными и уйдут, когда настроите.
  if (!token || !chatId) return json({ skipped: "Telegram для главного админа не настроен" });

  const db = serviceClient();
  const now = new Date().toISOString();
  // Сначала занимаем сообщения, чтобы два одновременных вызова не прислали одно и то же дважды.
  const { data: claimed, error } = await db.from("support_messages")
    .update({ notified_at: now })
    .eq("sender", "owner")
    .is("notified_at", null)
    .select("id, workspace_id, text, attachment_name, author_email, created_at")
    .order("created_at");
  if (error) return json({ error: error.message }, 500);
  if (!claimed || claimed.length === 0) return json({ sent: 0 });

  const { data: workspaces } = await db.from("workspaces").select("id, name").in("id", [...new Set(claimed.map((m) => m.workspace_id))]);
  const names = new Map((workspaces ?? []).map((w) => [w.id as string, w.name as string]));
  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");

  let sent = 0;
  for (const message of claimed) {
    const lines = [
      `Новое сообщение в поддержку Qabul`,
      `Компания: ${names.get(message.workspace_id) ?? "—"}${message.author_email ? ` (${message.author_email})` : ""}`,
      "",
      message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text,
    ];
    if (message.attachment_name) lines.push("", `Вложение: ${message.attachment_name}`);
    if (site) lines.push("", `${site}/#/platform/support/${message.workspace_id}`);

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), disable_web_page_preview: true }),
    }).catch(() => null);

    if (response?.ok) {
      sent++;
    } else {
      // Не дошло: возвращаем в очередь, повторим при следующем вызове.
      await db.from("support_messages").update({ notified_at: null }).eq("id", message.id);
    }
  }
  return json({ sent, failed: claimed.length - sent });
});
