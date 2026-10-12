import { NextResponse } from "next/server";
import { replyMessage, verifyLineSignature } from "@/lib/line/client";
import type { LineMessage } from "@/lib/line/client";
import { createServiceClient } from "@/lib/supabase/service";

type ParticipationType = "office" | "venue" | "zoom" | "absent";

type LineWebhookEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  postback?: { data: string; params?: { time?: string } };
  message?: { type: string; text?: string };
};

function isParticipationType(value: string | null): value is ParticipationType {
  return value === "office" || value === "venue" || value === "zoom" || value === "absent";
}

function labelFor(type: ParticipationType) {
  return type === "office" ? "オフィス参加" : type === "venue" ? "会場参加" : type === "zoom" ? "Zoom参加" : "不参加";
}

function translateError(message: string) {
  if (message.includes("Zoom participation is not available")) return "このイベントはZoom参加できません。";
  if (message.includes("Venue participation is not available")) return "このイベントは会場参加できません。";
  if (message.includes("Attendance is already confirmed")) return "すでに参加確認済みのため、変更するには管理者に取消を依頼してください。";
  if (message.includes("Not an event member")) return "このイベントの対象者ではありません。";
  if (message.includes("Active member required")) return "アカウントが無効です。管理者に確認してください。";
  if (message.includes("Event not found")) return "イベントが見つかりません。";
  return "回答を保存できませんでした。管理者に確認してください。";
}

async function replyMessages(replyToken: string | undefined, messages: LineMessage[]) {
  if (!replyToken) return;
  const result = await replyMessage(replyToken, messages);
  if (result.dryRun) {
    console.log("[LINE dry-run] would reply:", JSON.stringify(messages));
  } else if (!result.ok) {
    // The LINE API call itself failing was previously silent -- this was a
    // real bug, not just missing telemetry: a bad channel access token or
    // an expired/reused replyToken would look identical to success.
    console.error("[LINE] reply failed", result.status, result.body);
  }
}

async function reply(replyToken: string | undefined, text: string) {
  return replyMessages(replyToken, [{ type: "text", text }]);
}

function tokyoTimeHHmm(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function buildArrivalTimePickerMessage(eventId: string, initial: string): LineMessage {
  return {
    type: "template",
    altText: "オフィス参加の出社予定時刻を選んでください",
    template: {
      type: "buttons",
      text: "オフィス参加の出社予定時刻を選んでください",
      actions: [
        {
          type: "datetimepicker",
          label: "時刻を選ぶ",
          data: `action=respond_time&event_id=${eventId}`,
          mode: "time",
          initial,
        },
      ],
    },
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REGISTRATION_HELP =
  "このLINEはまだ登録されていません。\n登録するには、次の形式で送信してください。\n\n登録 氏名 メールアドレス\n（例）登録 山田太郎 yamada@example.com\n\n管理者の承認後、利用できるようになります。";

// "登録 氏名 メールアドレス" (half- or full-width spaces); the email may
// appear anywhere after the keyword, everything else is the name.
function parseRegistration(text: string): { name: string; email: string } | "no-keyword" | "bad-format" {
  const match = text.trim().slice(0, 500).match(/^登録[\s　]+(.+)$/);
  if (!match) return "no-keyword";
  const tokens = match[1].trim().split(/[\s　]+/);
  const emailIndex = tokens.findIndex((t) => EMAIL_PATTERN.test(t));
  if (emailIndex === -1) return "bad-format";
  const name = tokens.filter((_, i) => i !== emailIndex).join(" ").trim().slice(0, 100);
  if (!name) return "bad-format";
  return { name, email: tokens[emailIndex].toLowerCase().slice(0, 254) };
}

async function handleMessage(service: ReturnType<typeof createServiceClient>, event: LineWebhookEvent, lineUserId: string) {
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("id,active")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (profileError) {
    console.error("[LINE] profile lookup failed (message)", profileError.message, profileError.code);
  }

  if (profile && profile.active) {
    await reply(event.replyToken, "回答はイベント通知のボタンからお願いします。");
    return;
  }
  if (profile && !profile.active) {
    await reply(event.replyToken, "アカウントが無効です。管理者に確認してください。");
    return;
  }

  // Not linked yet: this is where a new person registers themselves.
  const parsed = parseRegistration(event.message?.text ?? "");
  if (parsed === "no-keyword") {
    await reply(event.replyToken, REGISTRATION_HELP);
    return;
  }
  if (parsed === "bad-format") {
    await reply(event.replyToken, `氏名とメールアドレスを確認してください。\n\n${REGISTRATION_HELP}`);
    return;
  }

  const { data: existing } = await service
    .from("line_registration_requests")
    .select("status")
    .eq("line_user_id", lineUserId)
    .maybeSingle();
  if (existing?.status === "pending") {
    await reply(event.replyToken, "すでに登録申請済みです。管理者の承認をお待ちください。");
    return;
  }

  const { error: requestError } = await service.from("line_registration_requests").upsert(
    {
      line_user_id: lineUserId,
      full_name: parsed.name,
      email: parsed.email,
      status: "pending",
      created_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
    },
    { onConflict: "line_user_id" }
  );
  if (requestError) {
    console.error("[LINE] registration request failed", requestError.message, requestError.code);
    await reply(event.replyToken, "登録申請を保存できませんでした。管理者に確認してください。");
    return;
  }

  await reply(event.replyToken, `「${parsed.name}」さんの登録申請を受け付けました。管理者の承認後、LINEでお知らせします。`);
}

async function recordResponse(
  service: ReturnType<typeof createServiceClient>,
  event: LineWebhookEvent,
  lineUserId: string,
  profileId: string,
  eventId: string,
  type: ParticipationType,
  plannedArrival: string | null
) {
  const { error } = await service.rpc("record_event_response_via_service", {
    p_member_id: profileId,
    p_event_id: eventId,
    p_participation_type: type,
    p_planned_arrival: plannedArrival,
    p_planned_departure: null,
  });

  // Direct insert: the service client bypasses RLS, and log_notification
  // requires an authenticated key_manager/admin session, which the webhook
  // never has (LINE authenticates the member, not Supabase).
  await service.from("notification_logs").insert({
    event_id: eventId,
    member_id: profileId,
    notification_type: "line_reply",
    destination: lineUserId,
    result: error ? "failed" : "recorded",
    error: error?.message ?? null,
  });

  const successText =
    type === "office" && plannedArrival
      ? `オフィス参加（${plannedArrival}出社予定）で回答を受け付けました。`
      : `${labelFor(type)}で回答を受け付けました。`;

  await reply(event.replyToken, error ? `回答を保存できませんでした：${translateError(error.message)}` : successText);
}

async function handlePostback(service: ReturnType<typeof createServiceClient>, event: LineWebhookEvent, lineUserId: string) {
  const params = new URLSearchParams(event.postback?.data ?? "");
  const action = params.get("action");
  const eventId = params.get("event_id");
  if (!eventId || (action !== "respond" && action !== "respond_time")) return;

  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("id,active")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (profileError) {
    console.error("[LINE] profile lookup failed (postback)", profileError.message, profileError.code);
  }

  if (!profile || !profile.active) {
    await reply(event.replyToken, "このLINEアカウントは連携されていないか、無効化されています。管理者に確認してください。");
    return;
  }

  if (action === "respond_time") {
    // Follow-up from the arrival-time picker sent below for an "office" tap.
    const time = event.postback?.params?.time;
    if (!time) {
      await reply(event.replyToken, "時刻を選択できませんでした。もう一度お試しください。");
      return;
    }
    await recordResponse(service, event, lineUserId, profile.id, eventId, "office", time);
    return;
  }

  const type = params.get("type");
  if (!isParticipationType(type)) return;

  if (type === "office") {
    // Office participation asks for an arrival time via LINE's native time
    // picker instead of recording immediately -- the actual save happens in
    // the "respond_time" branch above once the picker is submitted.
    const { data: eventRow, error: eventError } = await service
      .from("events")
      .select("starts_at")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError || !eventRow) {
      await reply(event.replyToken, "イベントが見つかりません。");
      return;
    }
    await replyMessages(event.replyToken, [buildArrivalTimePickerMessage(eventId, tokyoTimeHHmm(eventRow.starts_at))]);
    return;
  }

  await recordResponse(service, event, lineUserId, profile.id, eventId, type, null);
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  let payload: { events?: LineWebhookEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("invalid body", { status: 400 });
  }

  const service = createServiceClient();

  for (const event of payload.events ?? []) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) continue;
    try {
      if (event.type === "postback") {
        await handlePostback(service, event, lineUserId);
      } else if (event.type === "message" && event.message?.type === "text") {
        await handleMessage(service, event, lineUserId);
      } else if (event.type === "follow") {
        // Friend-add greeting. An already-linked member re-adding the bot
        // must not be told they are unregistered.
        const { data: linked } = await service
          .from("profiles")
          .select("id,active")
          .eq("line_user_id", lineUserId)
          .maybeSingle();
        await reply(
          event.replyToken,
          linked?.active ? "友だち追加ありがとうございます。イベントの通知・回答はこのLINEから行えます。" : REGISTRATION_HELP
        );
      }
    } catch (err) {
      console.error("LINE webhook event handling failed", err);
    }
  }

  return NextResponse.json({ ok: true });
}
