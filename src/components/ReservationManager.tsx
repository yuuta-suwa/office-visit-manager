"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { maxReservationDate, shortTime, tokyoDateString } from "@/lib/date";
import type { Profile, Reservation } from "@/lib/types";

const empty = () => ({ visit_date: tokyoDateString(), start_time: "09:00", end_time: "10:00", note: "", reason: "" });

export default function ReservationManager({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const [form, setForm] = useState(empty());
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Reservation[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("reservations").select("*").eq("user_id", currentUser.id).eq("status", "active").gte("visit_date", tokyoDateString()).order("visit_date").order("start_time");
    if (error) setError(error.message); else setRows((data ?? []) as Reservation[]);
  }, [currentUser.id, supabase]);

  useEffect(() => {
    load();
    const channel = supabase.channel(`my-reservations-${currentUser.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations", filter: `user_id=eq.${currentUser.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentUser.id, load, supabase]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(""); setMessage("");
    if (editing && !form.reason.trim()) { setError("変更理由を入力してください。"); return; }
    setBusy(true);
    const result = editing
      ? await supabase.rpc("update_reservation", {
          p_id: editing,
          p_visit_date: form.visit_date, p_start_time: form.start_time, p_end_time: form.end_time,
          p_note: form.note, p_reason: form.reason,
        })
      : await supabase.rpc("create_reservation", {
          p_visit_date: form.visit_date, p_start_time: form.start_time, p_end_time: form.end_time, p_note: form.note,
        });
    if (result.error) setError(result.error.message);
    else { setMessage(editing ? "予約を更新しました。" : "予約を登録しました。"); setEditing(null); setForm(empty()); await load(); }
    setBusy(false);
  }

  function edit(r: Reservation) {
    setEditing(r.id); setError(""); setMessage(""); setCancelingId(null);
    setForm({ visit_date: r.visit_date, start_time: shortTime(r.start_time), end_time: shortTime(r.end_time), note: r.note, reason: "" });
  }

  function startCancel(id: string) {
    setCancelingId(id); setCancelReason(""); setError(""); setMessage("");
  }

  function abortCancel() {
    setCancelingId(null); setCancelReason("");
  }

  async function confirmCancel(id: string) {
    if (!cancelReason.trim()) { setError("キャンセル理由を入力してください。"); return; }
    setError(""); setMessage(""); setBusy(true);
    const { error } = await supabase.rpc("cancel_reservation", { p_id: id, p_reason: cancelReason });
    if (error) setError(error.message);
    else {
      if (editing === id) { setEditing(null); setForm(empty()); }
      setCancelingId(null); setCancelReason("");
      setMessage("予約をキャンセルしました。");
      await load();
    }
    setBusy(false);
  }

  return (
    <section className="card">
      <h2>{editing ? "来社予約を編集" : "来社予約"}</h2>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field full"><label>来社日</label><input type="date" min={tokyoDateString()} max={maxReservationDate()} value={form.visit_date} onChange={e => setForm({...form, visit_date:e.target.value})} required /></div>
          <div className="field"><label>開始</label><input type="time" value={form.start_time} onChange={e => setForm({...form, start_time:e.target.value})} required /></div>
          <div className="field"><label>終了</label><input type="time" value={form.end_time} onChange={e => setForm({...form, end_time:e.target.value})} required /></div>
          <div className="field full"><label>メモ（500文字まで）</label><textarea maxLength={500} value={form.note} onChange={e => setForm({...form, note:e.target.value})} placeholder="訪問目的など" /></div>
          {editing && <div className="field full"><label>変更理由（必須・500文字まで）</label><textarea maxLength={500} value={form.reason} onChange={e => setForm({...form, reason:e.target.value})} placeholder="変更理由を入力してください" required /></div>}
        </div>
        {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? "処理中…" : editing ? "更新する" : "予約する"}</button>
          {editing && <button type="button" className="btn" onClick={() => {setEditing(null); setForm(empty());}}>編集をやめる</button>}
        </div>
      </form>
      <h2 style={{marginTop:24}}>自分の今後の予約</h2>
      {!rows.length ? <p className="muted">予約はありません。</p> : <div className="list">{rows.map(r => (
        <div className="row" key={r.id}>
          <div className="row-main"><div className="row-title">{r.visit_date}　{shortTime(r.start_time)}–{shortTime(r.end_time)}</div><div className="row-note">{r.note || "メモなし"}</div></div>
          {cancelingId === r.id ? (
            <div className="field full">
              <label>キャンセル理由（必須・500文字まで）</label>
              <textarea maxLength={500} value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="キャンセル理由を入力してください" autoFocus />
              <div className="actions">
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => confirmCancel(r.id)}>キャンセルを確定</button>
                <button type="button" className="btn" disabled={busy} onClick={abortCancel}>戻る</button>
              </div>
            </div>
          ) : (
            <div className="actions"><button className="btn" onClick={() => edit(r)}>編集</button><button className="btn btn-danger" onClick={() => startCancel(r.id)}>キャンセル</button></div>
          )}
        </div>
      ))}</div>}
    </section>
  );
}
