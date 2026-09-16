import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pushMessage } from "@/lib/line/client";
import type { LineQuickReplyAction } from "@/lib/line/client";

function action(eventId: string, type: string, label: string): LineQuickReplyAction {
  return {
    type: "action",
    action: {
      type: "postback",
      label,
      data: `action=respond&event_id=${eventId}&type=${type}`,
      displayText: `${label}で回答`,
    },
  };
}

function buildQuickReplyItems(eventRow: { id: string; office_required: boolean; zoom_allowed: boolean; venue_allowed: boolean }) {
  const items: LineQuickReplyAction[] = [action(eventRow.id, "office", "オフィス")];
  if (!eventRow.office_required && eventRow.venue_allowed) items.push(action(eventRow.id, "venue", "会場"));
  if (!eventRow.office_required && eventRow.zoom_allowed) items.push(action(eventRow.id, "zoom", "Zoom"));
  items.push(action(eventRow.id, "absent", "不参加"));
  return items;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("id,role,active").eq("id", user.id).single();
  if (!profile || !profile.active || profile.role !== "admin") {
    return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const eventId = body?.event_id;
  if (typeof eventId !== "string") {
    return NextResponse.json({ error: "event_id が必要です。" }, { status: 400 });
  }

  const { data: eventRow, error: eventError } = await supabase
    .from("events")
    .select("id,title,starts_at,office_required,zoom_allowed,venue_allowed")
    .eq("id", eventId)
    .single();
  if (eventError || !eventRow) {
    return NextResponse.json({ error: "イベントが見つかりません。" }, { status: 404 });
  }

  const { data: targets, error: targetsError } = await supabase.rpc("event_notification_targets", { p_event_id: eventId });
  if (targetsError) return NextResponse.json({ error: targetsError.message }, { status: 400 });

  const items = buildQuickReplyItems(eventRow);
  const dateLabel = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric" }).format(new Date(eventRow.starts_at));
  const text = `『${eventRow.title}』（${dateLabel}）の参加回答をお願いします。`;

  let sent = 0, skipped = 0, failed = 0;
  for (const target of targets ?? []) {
    if (!target.line_user_id) { skipped++; continue; }
    const result = await pushMessage(target.line_user_id, [{ type: "text", text, quickReply: { items } }]);
    const ok = result.dryRun || result.ok;
    if (ok) sent++; else failed++;
    await supabase.rpc("log_notification", {
      p_event_id: eventId,
      p_member_id: target.member_id,
      p_notification_type: "line_invite",
      p_destination: target.line_user_id,
      p_result: result.dryRun ? "dry_run" : ok ? "sent" : "failed",
      p_error: result.dryRun ? null : ok ? null : result.body,
    });
  }

  return NextResponse.json({ sent, skipped, failed });
}
