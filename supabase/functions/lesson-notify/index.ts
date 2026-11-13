// Сообщение ученикам о переносе или отмене урока через бота, который их опрашивал.
import { adapters } from "../_shared/adapters/index.ts";
import { credentialsOf, deliver, loadSecrets, serviceClient } from "../_shared/db.ts";
import { cors, errorResponse, json, readJson, requireUser } from "../_shared/http.ts";
import { ChannelError, type Platform } from "../_shared/types.ts";

interface Queued {
  message_id: string;
  text: string;
  channel_id: string;
  platform: Platform;
  channel_name: string;
  external_id: string;
  meta: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const db = serviceClient();
    const user = await requireUser(req, db);
    const body = await readJson(req);
    if (typeof body.lesson_id !== "string") throw new ChannelError("Не указан урок");
    if (body.kind !== "moved" && body.kind !== "cancelled") throw new ChannelError("Неизвестный вид сообщения");

    const { data, error } = await db.rpc("lesson_notify_prepare", {
      p_lesson: body.lesson_id,
      p_user: user.id,
      p_kind: body.kind,
      p_old_starts_at: typeof body.old_starts_at === "string" ? body.old_starts_at : null,
    });
    if (error) {
      if (error.code === "42501") throw new ChannelError("Урок не найден", 404);
      throw error;
    }

    const queued = (data?.messages ?? []) as Queued[];
    const byChannel = new Map<string, Queued[]>();
    for (const item of queued) byChannel.set(item.channel_id, [...(byChannel.get(item.channel_id) ?? []), item]);

    await Promise.all([...byChannel.values()].map(async (items) => {
      const { channel_id: channelId, platform, channel_name: channelName } = items[0];
      try {
        const secrets = await loadSecrets(db, channelId);
        if (!secrets) throw new Error("Канал отключён");
        const creds = await credentialsOf(secrets);
        for (const item of items) {
          await deliver(db, adapters[platform], {
            creds,
            channelName,
            contact: { externalId: item.external_id, meta: item.meta },
          }, [{ id: item.message_id, text: item.text }]);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        for (const item of items) {
          await db.rpc("bot_message_result", { p_message_id: item.message_id, p_external_id: null, p_error: message });
        }
      }
    }));

    let failed = 0;
    if (queued.length > 0) {
      const { count } = await db.from("messages").select("*", { count: "exact", head: true })
        .in("id", queued.map((m) => m.message_id)).eq("status", "failed");
      failed = count ?? 0;
    }
    return json({ sent: queued.length - failed, failed, skipped: data?.skipped ?? 0 });
  } catch (error) {
    return errorResponse(error);
  }
});
