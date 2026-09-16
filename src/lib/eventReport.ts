import { shortTime } from "@/lib/date";
import type { EventAttendanceRow, EventItem } from "@/lib/types";

// Shared by the client-side report-copy panel (EventManager.tsx) and the
// server-side LINE report push (api/line/send-report), so the two never
// drift into different wording for the same roster.
export function buildEventReportText(
  event: Pick<EventItem, "title" | "starts_at" | "venue_name">,
  rows: EventAttendanceRow[]
) {
  const participants = rows.filter(
    (row) =>
      row.participation_type === "office" ||
      row.participation_type === "venue" ||
      row.participation_type === "zoom"
  );
  const absent = rows.filter((row) => row.participation_type === "absent");
  const unanswered = rows.filter((row) => !row.participation_type);

  const lines = [
    `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric" }).format(new Date(event.starts_at))} ${event.title}`,
    "",
    "【参加者】",
  ];

  lines.push(
    ...participants.map((row) => {
      const participation =
        row.participation_type === "office"
          ? `オフィス参加　${row.planned_arrival ? `${shortTime(row.planned_arrival)}出社予定` : ""}`
          : row.participation_type === "venue"
            ? `会場参加　${event.venue_name || ""}`
            : "Zoom参加";

      return `${row.full_name}　${participation}${row.attendance_confirmed ? "　⭕️" : ""}`;
    })
  );

  if (absent.length) {
    lines.push("", "【不参加】", ...absent.map((row) => row.full_name));
  }

  if (unanswered.length) {
    lines.push("", "【未回答】", ...unanswered.map((row) => row.full_name));
  }

  lines.push("", "⭕️＝参加確認済／空白＝未参加確認");

  return lines.join("\n");
}
