"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTokyoDateTime, shortTime } from "@/lib/date";
import type { EventItem, EventResponse, Profile } from "@/lib/types";

type AttendanceRow = {
  member_id: string; full_name: string; participation_type: "office" | "zoom" | "absent" | null;
  planned_arrival: string | null; attendance_confirmed: boolean; responded_at: string | null;
};
const blank = () => ({ title:"", date:"", start:"21:00", end:"23:00", office_required:false, zoom_allowed:true, description:"" });

export default function EventManager({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const canManage = currentUser.role === "admin";
  const canConfirm = currentUser.role === "admin" || currentUser.role === "key_manager";
  const [events, setEvents] = useState<EventItem[]>([]);
  const [responses, setResponses] = useState<Record<string, EventResponse>>({});
  const [members, setMembers] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState(blank());
  const [openedEventId, setOpenedEventId] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const eventById = useMemo(() => new Map(events.map(e => [e.id, e])), [events]);
  const load = useCallback(async () => {
    const { data: eventData, error: eventError } = await supabase.from("events").select("id,title,starts_at,ends_at,office_required,zoom_allowed,description").gte("ends_at", new Date().toISOString()).order("starts_at");
    if (eventError) return setError(eventError.message);
    const { data: responseData, error: responseError } = await supabase.from("event_responses").select("event_id,participation_type,planned_arrival,planned_departure,attendance_confirmed");
    if (responseError) return setError(responseError.message);
    setEvents((eventData ?? []) as EventItem[]);
    setResponses(Object.fromEntries(((responseData ?? []) as EventResponse[]).map(r => [r.event_id, r])));
    if (canManage) {
      const { data, error } = await supabase.from("profiles").select("id,full_name,role,active,team,jurisdiction").eq("active", true).order("full_name");
      if (error) setError(error.message); else setMembers((data ?? []) as Profile[]);
    }
  }, [canManage, supabase]);
  useEffect(() => { load(); }, [load]);

  async function respond(event: EventItem, type: EventResponse["participation_type"]) {
    setError(""); setMessage("");
    const arrival = type === "office" ? (responses[event.id]?.planned_arrival ? shortTime(responses[event.id].planned_arrival!) : "21:00") : null;
    const { error } = await supabase.rpc("respond_to_event", { p_event_id:event.id, p_participation_type:type, p_planned_arrival:arrival, p_planned_departure:null });
    if (error) setError(error.message); else { setMessage("参加予定を保存しました。"); await load(); }
  }
  async function createEvent(e: FormEvent) {
    e.preventDefault(); setError(""); setMessage("");
    if (!form.date || !selected.length) return setError("開催日と参加対象者を入力してください。");
    const start = new Date(`${form.date}T${form.start}:00+09:00`).toISOString();
    const end = new Date(`${form.date}T${form.end}:00+09:00`).toISOString();
    const { error } = await supabase.rpc("create_event_with_members", {
      p_title:form.title, p_event_type:"other", p_starts_at:start, p_ends_at:end, p_office_required:form.office_required,
      p_zoom_allowed:form.zoom_allowed, p_description:form.description, p_member_ids:selected,
      p_notification_member_ids:selected, p_report_recipient_ids:[currentUser.id],
    });
    if (error) setError(error.message); else { setForm(blank()); setSelected([]); setMessage("イベントを作成しました。"); await load(); }
  }
  async function openAttendance(eventId: string) {
    setError(""); const { data, error } = await supabase.rpc("event_attendance_admin", { p_event_id:eventId });
    if (error) return setError(error.message);
    setAttendance((data ?? []) as AttendanceRow[]); setOpenedEventId(eventId);
  }
  async function confirm(row: AttendanceRow, checked: boolean) {
    const { error } = await supabase.rpc("confirm_event_attendance", { p_event_id:openedEventId, p_member_id:row.member_id, p_confirmed:checked });
    if (error) setError(error.message); else if (openedEventId) await openAttendance(openedEventId);
  }
  function reportText() {
    if (!openedEventId) return "";
    const event = eventById.get(openedEventId);
    if (!event) return "";
    const participants = attendance.filter(x => x.participation_type === "office" || x.participation_type === "zoom");
    const absent = attendance.filter(x => x.participation_type === "absent");
    const unanswered = attendance.filter(x => !x.participation_type);
    const lines = [`${formatTokyoDateTime(event.starts_at).slice(0, 10)} ${event.title}`, "", "【参加者】"];
    lines.push(...participants.map(x => `${x.full_name}　${x.participation_type === "office" ? `オフィス参加　${x.planned_arrival ? shortTime(x.planned_arrival) + "出社予定" : ""}` : "Zoom参加"}${x.attendance_confirmed ? "　⭕️" : ""}`));
    if (absent.length) lines.push("", "【不参加】", ...absent.map(x => x.full_name));
    if (unanswered.length) lines.push("", "【未回答】", ...unanswered.map(x => x.full_name));
    lines.push("", "⭕️＝参加確認済／空白＝未参加確認");
    return lines.join("\n");
  }
  async function copyReport() {
    try { await navigator.clipboard.writeText(reportText()); setMessage("社長報告文をコピーしました。"); }
    catch { setError("コピーできませんでした。ブラウザの権限を確認してください。"); }
  }
  function toggle(id: string) { setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev,id]); }

  return <section className="card"><div className="section-head"><h2>イベント参加</h2><span className="badge">{canManage ? "管理" : "自分の対象イベント"}</span></div>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
    {canManage && <form onSubmit={createEvent} className="event-form"><h3>イベントを作成</h3><div className="form-grid"><div className="field full"><label>イベント名</label><input required value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="LIFE STAGE 1.0 / 2.0" /></div><div className="field"><label>開催日</label><input type="date" required value={form.date} onChange={e=>setForm({...form,date:e.target.value})} /></div><div className="field"><label>時間</label><div className="actions"><input type="time" value={form.start} onChange={e=>setForm({...form,start:e.target.value})} /><input type="time" value={form.end} onChange={e=>setForm({...form,end:e.target.value})} /></div></div><div className="field full"><label>参加対象者（{selected.length}名選択）</label><div className="member-picker">{members.map(m=><label key={m.id}><input type="checkbox" checked={selected.includes(m.id)} onChange={()=>toggle(m.id)} /> {m.full_name}</label>)}</div></div><div className="field full"><label>説明（任意）</label><textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})} /></div></div><div className="actions"><label><input type="checkbox" checked={form.office_required} onChange={e=>setForm({...form,office_required:e.target.checked})} /> オフィス参加必須</label><label><input type="checkbox" checked={form.zoom_allowed} onChange={e=>setForm({...form,zoom_allowed:e.target.checked})} /> Zoom参加可</label><button className="btn btn-primary">作成する</button></div></form>}
    {!events.length ? <p className="muted">現在、回答が必要なイベントはありません。</p> : <div className="list">{events.map(event => { const response=responses[event.id]; return <div className="row" key={event.id}><div className="row-main"><div className="row-title">{event.title}</div><div className="row-note">{formatTokyoDateTime(event.starts_at)}〜{formatTokyoDateTime(event.ends_at)}{response?.attendance_confirmed ? "　⭕️参加確認済" : ""}</div></div><div className="actions">{canConfirm && <button className="btn" onClick={()=>openAttendance(event.id)}>当日名簿</button>}<button className="btn btn-primary" disabled={event.office_required} onClick={()=>respond(event,"office")}>オフィス</button>{event.zoom_allowed && <button className="btn" onClick={()=>respond(event,"zoom")}>Zoom</button>}<button className="btn btn-danger" onClick={()=>respond(event,"absent")}>不参加</button></div></div>; })}</div>}
    {openedEventId && <div className="attendance-panel"><div className="section-head"><h3>{eventById.get(openedEventId)?.title}｜当日名簿</h3><div className="actions"><button className="btn btn-primary" onClick={copyReport}>社長報告文をコピー</button><button className="btn" onClick={()=>setOpenedEventId(null)}>閉じる</button></div></div>{attendance.map(row=><div className="row" key={row.member_id}><div className="row-main"><div className="row-title">{row.full_name} {row.attendance_confirmed ? "⭕️" : ""}</div><div className="row-note">{row.participation_type === "office" ? `オフィス ${row.planned_arrival ? shortTime(row.planned_arrival) : ""}` : row.participation_type === "zoom" ? "Zoom" : row.participation_type === "absent" ? "不参加" : "未回答"}</div></div><button className={row.attendance_confirmed ? "btn btn-success" : "btn"} disabled={!row.participation_type || row.participation_type === "absent"} onClick={()=>confirm(row,!row.attendance_confirmed)}>{row.attendance_confirmed ? "確認を戻す" : "⭕️参加確認"}</button></div>)}</div>}
  </section>;
}
