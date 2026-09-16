import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pushMessage } from "@/lib/line/client";
import { buildEventReportText } from "@/lib/eventReport";
import type { EventAttendanceRow } from "@/lib/types";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("id,role,active").eq("id", user.id).single();
  if (!profile || !profile.active || (profile.role !== "admin" && profile.role !== "key_manager")) {
    return NextResponse.json({ error: "管理者または鍵管理者権限が必要です。" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const eventId = body?.event_id;
  if (typeof eventId !== "string") {
    return NextResponse.json({ error: "event_id が必要です。" }, { status: 400 });
  }

  const { data: eventRow, error: eventError } = await supabase
    .from("events")
    .select("id,title,starts_at,venue_name")
    .eq("id", eventId)
    .single();
  if (eventError || !eventRow) {
    return NextResponse.json({ error: "イベントが見つかりません。" }, { status: 404 });
  }

  const { data: rosterData, error: rosterError } = await supabase.rpc("event_attendance_admin", { p_event_id: eventId });
  if (rosterError) return NextResponse.json({ error: rosterError.message }, { status: 400 });

  const text = buildEventReportText(eventRow, (rosterData ?? []) as EventAttendanceRow[]);

  const { data: recipients, error: recipientsError } = await supabase.rpc("event_report_recipients", { p_event_id: eventId });
  if (recipientsError) return NextResponse.json({ error: recipientsError.message }, { status: 400 });

  let sent = 0, skipped = 0, failed = 0;
  for (const recipient of recipients ?? []) {
    if (!recipient.line_user_id) { skipped++; continue; }
    const result = await pushMessage(recipient.line_user_id, [{ type: "text", text }]);
    const ok = result.dryRun || result.ok;
    if (ok) sent++; else failed++;
    await supabase.rpc("log_notification", {
      p_event_id: eventId,
      p_member_id: recipient.member_id,
      p_notification_type: "line_report",
      p_destination: recipient.line_user_id,
      p_result: result.dryRun ? "dry_run" : ok ? "sent" : "failed",
      p_error: result.dryRun ? null : ok ? null : result.body,
    });
  }

  return NextResponse.json({ sent, skipped, failed });
}
