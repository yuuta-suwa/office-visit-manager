"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { tokyoDateString } from "@/lib/date";
import type { OfficeCalendarRangeSummary } from "@/lib/types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// MEMBER receives this aggregate only, same as TodayVisitors: never another
// member's name, note, or individual reservation time -- just a per-day count.
export default function OfficeCalendar() {
  const supabase = createClient();
  const todayStr = tokyoDateString();
  const [todayYear, todayMonth] = todayStr.split("-").map(Number);
  const [cursor, setCursor] = useState({ year: todayYear, month: todayMonth });
  const [rows, setRows] = useState<OfficeCalendarRangeSummary[]>([]);
  const [error, setError] = useState("");

  const daysInMonth = useMemo(
    () => new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate(),
    [cursor]
  );
  const firstWeekday = useMemo(
    () => new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).getUTCDay(),
    [cursor]
  );
  const rangeStart = `${cursor.year}-${pad(cursor.month)}-01`;
  const rangeEnd = `${cursor.year}-${pad(cursor.month)}-${pad(daysInMonth)}`;

  const load = useCallback(async () => {
    setError("");
    const { data, error } = await supabase.rpc("office_calendar_range_summary", {
      p_start: rangeStart,
      p_end: rangeEnd,
    });
    if (error) return setError(error.message);
    setRows((data ?? []) as OfficeCalendarRangeSummary[]);
  }, [supabase, rangeStart, rangeEnd]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("office-calendar-range-ui")
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load, supabase]);

  const byDate = useMemo(() => {
    const map = new Map<string, OfficeCalendarRangeSummary>();
    for (const row of rows) map.set(row.visit_date, row);
    return map;
  }, [rows]);

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  function goPrevMonth() {
    setCursor((c) => (c.month === 1 ? { year: c.year - 1, month: 12 } : { year: c.year, month: c.month - 1 }));
  }

  function goNextMonth() {
    setCursor((c) => (c.month === 12 ? { year: c.year + 1, month: 1 } : { year: c.year, month: c.month + 1 }));
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>出社可能カレンダー</h2>
        <div className="actions">
          <button type="button" className="btn" onClick={goPrevMonth}>
            ←
          </button>
          <span className="badge">
            {cursor.year}年{cursor.month}月
          </span>
          <button type="button" className="btn" onClick={goNextMonth}>
            →
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <p className="muted">個人名・個別予定は表示されません。人数は来社予約の件数です。</p>
      <div className="calendar-grid">
        {WEEKDAYS.map((w) => (
          <div className="calendar-weekday" key={w}>
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div className="calendar-cell calendar-cell-empty" key={`empty-${i}`} />;
          const dateStr = `${cursor.year}-${pad(cursor.month)}-${pad(day)}`;
          const summary = byDate.get(dateStr);
          const isToday = dateStr === todayStr;
          return (
            <div className={`calendar-cell${isToday ? " calendar-cell-today" : ""}`} key={dateStr}>
              <div className="calendar-day">{day}</div>
              {summary && (
                <div className="calendar-count">
                  {summary.planned_count}名
                  {summary.has_unlock ? <span className="calendar-unlock">・開錠</span> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
