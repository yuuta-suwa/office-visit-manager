"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTokyoDateTime, shortTime } from "@/lib/date";
import type { EventItem, EventResponse } from "@/lib/types";

export default function EventManager() {
  const supabase = createClient();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [responses, setResponses] = useState<Record<string, EventResponse>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data: eventData, error: eventError } = await supabase.from("events").select("id,title,starts_at,ends_at,office_required,zoom_allowed,description").gte("ends_at", new Date().toISOString()).order("starts_at");
    if (eventError) return setError(eventError.message);
    const { data: responseData, error: responseError } = await supabase.from("event_responses").select("event_id,participation_type,planned_arrival,planned_departure,attendance_confirmed");
    if (responseError) return setError(responseError.message);
    setEvents((eventData ?? []) as EventItem[]);
    setResponses(Object.fromEntries(((responseData ?? []) as EventResponse[]).map(r => [r.event_id, r])));
  }, [supabase]);

  useEffect(() => { load(); }, [load]);
  async function respond(event: EventItem, type: EventResponse["participation_type"]) {
    setError(""); setMessage("");
    const current = responses[event.id];
    const arrival = type === "office" ? (current?.planned_arrival ? shortTime(current.planned_arrival) : "21:00") : null;
    const { error } = await supabase.rpc("respond_to_event", { p_event_id:event.id, p_participation_type:type, p_planned_arrival:arrival, p_planned_departure:null });
    if (error) setError(error.message); else { setMessage("参加予定を保存しました。"); await load(); }
  }

  return <section className="card">
    <div className="section-head"><h2>イベント参加</h2><span className="badge">自分の対象イベント</span></div>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
    {!events.length ? <p className="muted">現在、回答が必要なイベントはありません。</p> : <div className="list">{events.map(event => {
      const response = responses[event.id];
      return <div className="row" key={event.id}><div className="row-main"><div className="row-title">{event.title}</div><div className="row-note">{formatTokyoDateTime(event.starts_at)}〜{formatTokyoDateTime(event.ends_at)}{response?.attendance_confirmed ? "　⭕️参加確認済" : ""}</div></div><div className="actions"><button className="btn btn-primary" disabled={event.office_required} onClick={() => respond(event,"office")}>オフィス</button>{event.zoom_allowed && <button className="btn" onClick={() => respond(event,"zoom")}>Zoom</button>}<button className="btn btn-danger" onClick={() => respond(event,"absent")}>不参加</button></div></div>;
    })}</div>}
  </section>;
}
