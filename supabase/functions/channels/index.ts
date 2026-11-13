// Подключение, проверка и отключение каналов. Токены принимает только эта функция:
// в базу они попадают зашифрованными, обратно в браузер не возвращаются.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { adapters } from "../_shared/adapters/index.ts";
import { encrypt, randomHex } from "../_shared/crypto.ts";
import { credentialsOf, loadSecrets, serviceClient } from "../_shared/db.ts";
import { cors, errorResponse, json, readJson, requireOwner, requireUser } from "../_shared/http.ts";
import { ChannelError, type Credentials, META_PLATFORMS, type Platform, PLATFORMS } from "../_shared/types.ts";

const functionsUrl = () => `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1`;
const isMeta = (platform: Platform) => META_PLATFORMS.includes(platform);

function setupInfo(platform: Platform, secret: string) {
  if (!isMeta(platform)) return null;
  return { callback_url: `${functionsUrl()}/webhook/meta`, verify_token: secret };
}

const webhookUrl = (platform: Platform, channelId: string) =>
  `${functionsUrl()}/webhook/${isMeta(platform) ? "meta" : channelId}`;

/** Понятная подсказка, почему сообщение не дошло. */
function explainSendError(platform: Platform, message: string): string {
  if (/\b401\b|unauthor|invalid.*token|token.*(expired|invalid)|OAuthException|\(#190\)|code.?190/i.test(message)) {
    return "Токен недействителен или истёк. Выпустите новый токен и подключите канал заново.";
  }
  if (platform === "telegram" && /blocked|chat not found|user is deactivated|Forbidden/i.test(message)) {
    return "Клиент заблокировал бота или ещё ни разу не писал ему. Telegram не даёт писать первым.";
  }
  if (isMeta(platform) && /24|window|outside.*allowed|\(#10\)|\(#200\)|2534022|2018278/i.test(message)) {
    return "Meta разрешает отвечать только в течение 24 часов после последнего сообщения клиента. Попросите его написать снова.";
  }
  if (platform === "instagram" && /permission|not.*authorized|role|tester|\(#3\)|\(#100\)/i.test(message)) {
    return "Instagram отвечает только тем, у кого есть роль в приложении Meta (тестер), пока Meta не одобрила приложение. Добавьте аккаунт как Instagram Tester.";
  }
  if (platform === "whatsapp" && /131047|re-engagement|template/i.test(message)) {
    return "WhatsApp разрешает свободный текст только в течение 24 часов после сообщения клиента.";
  }
  if (platform === "viber" && /receiver|not subscribed|unsubscribed/i.test(message)) {
    return "Клиент не подписан на бота в Viber.";
  }
  return "Причина неизвестна. Нажмите «Проверить»: если проверка проходит, проблема в самом получателе.";
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * Включает webhook на стороне платформы. У Meta подписка возможна только после настройки
 * Callback URL в кабинете разработчика, поэтому там ошибка не прерывает подключение,
 * а превращается в предупреждение: владелец нажмёт «Проверить» после настройки.
 */
async function activate(db: SupabaseClient, channel: { id: string; platform: Platform; last_event_at: string | null }, identity: Awaited<ReturnType<typeof adapters.telegram.identify>>, creds: Credentials, secret: string) {
  const adapter = adapters[channel.platform];
  try {
    await adapter.activate({
      creds,
      identity,
      webhookUrl: webhookUrl(channel.platform, channel.id),
      secret,
      saveExtra: async (patch) => {
        const current = await loadSecrets(db, channel.id);
        const { error } = await db.from("channel_secrets")
          .update({ extra: { ...(current?.extra ?? {}), ...patch } })
          .eq("channel_id", channel.id);
        if (error) throw error;
      },
    });
    await db.from("channels").update({
      status: isMeta(channel.platform) && !channel.last_event_at ? "pending" : "active",
      last_error: null,
      last_error_at: null,
    }).eq("id", channel.id);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("channels").update({
      status: isMeta(channel.platform) ? "pending" : "error",
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    }).eq("id", channel.id);
    if (!isMeta(channel.platform)) throw error;
    return message;
  }
}

async function connect(db: SupabaseClient, body: Record<string, unknown>) {
  const platform = body.platform as Platform;
  if (!PLATFORMS.includes(platform)) throw new ChannelError("Неизвестная соцсеть");

  const token = text(body.token);
  if (!token) throw new ChannelError("Вставьте токен");

  const appSecret = text(body.app_secret);
  if (isMeta(platform) && !appSecret) throw new ChannelError("Вставьте App Secret: без него нельзя проверить подпись webhook");

  const phoneNumberId = text(body.phone_number_id);
  const wabaId = text(body.waba_id);
  if (platform === "whatsapp" && (!phoneNumberId || !wabaId)) {
    throw new ChannelError("Укажите Phone number ID и WhatsApp Business Account ID");
  }

  const accountId = platform === "instagram" ? text(body.account_id)?.replace(/\D/g, "") || undefined : undefined;
  const creds: Credentials = { token, appSecret, phoneNumberId, wabaId, accountId };
  const identity = await adapters[platform].identify(creds);

  const { data: existing, error: findError } = await db.from("channels").select("*")
    .eq("platform", platform).eq("external_id", identity.externalId).is("deleted_at", null).maybeSingle();
  if (findError) throw findError;
  if (existing && existing.workspace_id !== body.workspace_id) {
    throw new ChannelError("Этот аккаунт уже подключён в другом кабинете");
  }

  // Повторное подключение того же аккаунта просто обновляет токен.
  const fields = {
    name: identity.name,
    username: identity.username ?? null,
    token_hint: `••••${token.slice(-4)}`,
    token_expires_at: identity.tokenExpiresAt ?? null,
    is_active: true,
  };
  let channel;
  if (existing) {
    const { data, error } = await db.from("channels").update(fields).eq("id", existing.id).select().single();
    if (error) throw error;
    channel = data;
  } else {
    const { data, error } = await db.from("channels").insert({
      ...fields,
      workspace_id: body.workspace_id,
      platform,
      external_id: identity.externalId,
    }).select().single();
    if (error) throw error;
    channel = data;
  }

  const previous = await loadSecrets(db, channel.id);
  const secret = previous?.webhook_secret ?? randomHex(24);
  const { error: secretError } = await db.from("channel_secrets").upsert({
    channel_id: channel.id,
    token_enc: await encrypt(token),
    app_secret_enc: appSecret ? await encrypt(appSecret) : null,
    webhook_secret: secret,
    extra: {
      ...(previous?.extra ?? {}),
      ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
      ...(wabaId ? { waba_id: wabaId } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
    updated_at: new Date().toISOString(),
  });
  if (secretError) throw secretError;

  const warning = await activate(db, channel, identity, creds, secret);
  const { data: fresh } = await db.from("channels").select("*").eq("id", channel.id).single();
  return { channel: fresh, setup: setupInfo(platform, secret), warning };
}

async function ownedChannel(db: SupabaseClient, userId: string, channelId: unknown) {
  if (typeof channelId !== "string") throw new ChannelError("Не указан канал");
  const { data: channel, error } = await db.from("channels").select("*").eq("id", channelId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!channel) throw new ChannelError("Канал не найден", 404);
  await requireOwner(db, userId, channel.workspace_id);
  return channel;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const db = serviceClient();
    const user = await requireUser(req, db);
    const body = await readJson(req);

    switch (body.action) {
      case "connect": {
        await requireOwner(db, user.id, body.workspace_id);
        return json(await connect(db, body));
      }
      case "setup": {
        const channel = await ownedChannel(db, user.id, body.channel_id);
        const secrets = await loadSecrets(db, channel.id);
        if (!secrets) throw new ChannelError("Подключите канал заново: настройки не найдены");
        return json({ setup: setupInfo(channel.platform, secrets.webhook_secret) });
      }
      case "check": {
        const channel = await ownedChannel(db, user.id, body.channel_id);
        const secrets = await loadSecrets(db, channel.id);
        if (!secrets) throw new ChannelError("Подключите канал заново: настройки не найдены");
        const creds = await credentialsOf(secrets);
        const identity = await adapters[channel.platform as Platform].identify(creds).catch(async (error) => {
          await db.from("channels").update({
            status: "error",
            last_error: String(error.message).slice(0, 500),
            last_error_at: new Date().toISOString(),
          }).eq("id", channel.id);
          throw error;
        });
        const warning = await activate(db, channel, identity, creds, secrets.webhook_secret);
        const { data: fresh } = await db.from("channels").select("*").eq("id", channel.id).single();
        return json({ channel: fresh, warning });
      }
      case "test": {
        const channel = await ownedChannel(db, user.id, body.channel_id);
        if (typeof body.contact_id !== "string") throw new ChannelError("Выберите, кому отправить тест");
        // Тест уходит только тому, кто уже писал в этот канал: так он не превращается в рассылку.
        const { data: contact, error: contactError } = await db.from("contacts").select("id, external_id, meta")
          .eq("id", body.contact_id).eq("channel_id", channel.id).maybeSingle();
        if (contactError) throw contactError;
        if (!contact) throw new ChannelError("Выберите того, кто уже писал в этот канал", 404);
        const secrets = await loadSecrets(db, channel.id);
        if (!secrets) throw new ChannelError("Подключите канал заново: настройки не найдены");
        try {
          await adapters[channel.platform as Platform].send({
            creds: await credentialsOf(secrets),
            channelName: channel.name,
            contact: { externalId: contact.external_id, meta: contact.meta },
          }, { text: "Тестовое сообщение от Qabul. Если вы его видите, канал отвечает." });
          return json({ ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: message.slice(0, 500), hint: explainSendError(channel.platform as Platform, message) });
        }
      }
      case "disconnect": {
        const channel = await ownedChannel(db, user.id, body.channel_id);
        const secrets = await loadSecrets(db, channel.id);
        if (secrets) {
          // Отписка у платформы может не пройти, если токен уже отозван. Канал всё равно отключаем.
          const creds = await credentialsOf(secrets);
          await adapters[channel.platform as Platform].deactivate(creds).catch((e) => console.warn("deactivate", e.message));
        }
        await db.from("channel_secrets").delete().eq("channel_id", channel.id);
        // Канал скрывается, а заявки и переписка остаются в истории.
        const { error } = await db.from("channels").update({ deleted_at: new Date().toISOString(), is_active: false }).eq("id", channel.id);
        if (error) throw error;
        return json({ ok: true });
      }
      default:
        throw new ChannelError("Неизвестное действие");
    }
  } catch (error) {
    return errorResponse(error);
  }
});
