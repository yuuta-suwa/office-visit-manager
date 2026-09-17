import { NextResponse } from "next/server";
import { replyMessage, verifyLineSignature } from "@/lib/line/client";
import { createServiceClient } from "@/lib/supabase/service";

type ParticipationType = "office" | "venue" | "zoom" | "absent";

type LineWebhookEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  postback?: { data: string };
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

async function reply(replyToken: string | undefined, text: string) {
  if (!replyToken) return;
  const result = await replyMessage(replyToken, [{ type: "text", text }]);
  if (result.dryRun) {
    console.log("[LINE dry-run] would reply:", text);
  } else if (!result.ok) {
    // The LINE API call itself failing was previously silent -- this was a
    // real bug, not just missing telemetry: a bad channel access token or
    // an expired/reused replyToken would look identical to success.
    console.error("[LINE] reply failed", result.status, result.body);
  }
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

async function handlePostback(service: ReturnType<typeof createServiceClient>, event: LineWebhookEvent, lineUserId: string) {
  const params = new URLSearchParams(event.postback?.data ?? "");
  if (params.get("action") !== "respond") return;

  const eventId = params.get("event_id");
  const type = params.get("type");
  if (!eventId || !isParticipationType(type)) return;

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

  const { error } = await service.rpc("record_event_response_via_service", {
    p_member_id: profile.id,
    p_event_id: eventId,
    p_participation_type: type,
    p_planned_arrival: null,
    p_planned_departure: null,
  });

  // Direct insert: the service client bypasses RLS, and log_notification
  // requires an authenticated key_manager/admin session, which the webhook
  // never has (LINE authenticates the member, not Supabase).
  await service.from("notification_logs").insert({
    event_id: eventId,
    member_id: profile.id,
    notification_type: "line_reply",
    destination: lineUserId,
    result: error ? "failed" : "recorded",
    error: error?.message ?? null,
  });

  await reply(
    event.replyToken,
    error ? `回答を保存できませんでした：${translateError(error.message)}` : `${labelFor(type)}で回答を受け付けました。`
  );
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
