"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { shortTime, tokyoDateString } from "@/lib/date";
import type { OfficeCalendarSummary } from "@/lib/types";

// MEMBER receives this aggregate only: never another member's name, note, or individual time.
export default function TodayVisitors() {
  const supabase = createClient();
  const [rows, setRows] = useState<OfficeCalendarSummary[]>([]);
  const [error, setError] = useState("");
  const today = tokyoDateString();
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("office_calendar_summary", { p_date: today });
    if (error) return setError(error.message);
    setRows((data ?? []) as OfficeCalendarSummary[]);
  }, [supabase, today]);

  useEffect(() => {
    load();
    const channel = supabase.channel("office-calendar-summary-ui")
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, supabase]);

  return <section className="card">
    <div className="section-head"><h2>今日の利用予定</h2><span className="badge">{today}</span></div>
    {error && <div className="error">{error}</div>}
    {!rows.length ? <p className="muted">本日の利用予定はありません。</p> : <div className="list">{rows.map(r => (
      <div className="row" key={r.time_slot}>
        <div className="row-main"><div className="row-title">{shortTime(r.time_slot)}から</div><div className="row-note">個人名・個別予定は表示されません</div></div>
        <div className="time">{r.planned_count}名予定 {r.has_unlock ? "・開錠予定" : ""}</div>
      </div>
    ))}</div>}
  </section>;
}
