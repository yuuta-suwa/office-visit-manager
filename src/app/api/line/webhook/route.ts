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

  // Not linked yet: surface the sender's own LINE user ID so an admin can
  // set it on their profiles.line_user_id row. This is the only place a
  // member can see their own ID; there is no other self-service way to
  // find it, and it is not sensitive (it's meaningless without matching
  // account access).
  await reply(
    event.replyToken,
    `このLINEアカウントはまだ連携されていません。管理者に下記のLINEユーザーIDを伝えて連携してもらってください。\n\nLINEユーザーID:\n${lineUserId}`
  );
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
      }
    } catch (err) {
      console.error("LINE webhook event handling failed", err);
    }
  }

  return NextResponse.json({ ok: true });
}
