"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { maxReservationDate, shortTime, tokyoDateString } from "@/lib/date";
import type { Profile, Reservation } from "@/lib/types";

const empty = () => ({ visit_date: tokyoDateString(), start_time: "09:00", end_time: "10:00", note: "" });

export default function ReservationManager({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const [form, setForm] = useState(empty());
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Reservation[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("reservations").select("*").eq("user_id", currentUser.id).gte("visit_date", tokyoDateString()).order("visit_date").order("start_time");
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
    e.preventDefault(); setBusy(true); setError(""); setMessage("");
    const params = { p_visit_date: form.visit_date, p_start_time: form.start_time, p_end_time: form.end_time, p_note: form.note };
    const result = editing
      ? await supabase.rpc("update_reservation", { p_id: editing, ...params })
      : await supabase.rpc("create_reservation", params);
    if (result.error) setError(result.error.message);
    else { setMessage(editing ? "予約を更新しました。" : "予約を登録しました。"); setEditing(null); setForm(empty()); await load(); }
    setBusy(false);
  }

  function edit(r: Reservation) {
    setEditing(r.id); setError(""); setMessage("");
    setForm({ visit_date: r.visit_date, start_time: shortTime(r.start_time), end_time: shortTime(r.end_time), note: r.note });
  }

  async function remove(id: string) {
    if (!window.confirm("この予約を削除しますか？")) return;
    setError(""); setMessage("");
    const { error } = await supabase.rpc("delete_reservation", { p_id: id });
    if (error) setError(error.message); else { if (editing === id) { setEditing(null); setForm(empty()); } setMessage("予約を削除しました。"); await load(); }
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
        </div>
        {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? "処理中…" : editing ? "更新する" : "予約する"}</button>
          {editing && <button type="button" className="btn" onClick={() => {setEditing(null); setForm(empty());}}>キャンセル</button>}
        </div>
      </form>
      <h2 style={{marginTop:24}}>自分の今後の予約</h2>
      {!rows.length ? <p className="muted">予約はありません。</p> : <div className="list">{rows.map(r => (
        <div className="row" key={r.id}>
          <div className="row-main"><div className="row-title">{r.visit_date}　{shortTime(r.start_time)}–{shortTime(r.end_time)}</div><div className="row-note">{r.note || "メモなし"}</div></div>
          <div className="actions"><button className="btn" onClick={() => edit(r)}>編集</button><button className="btn btn-danger" onClick={() => remove(r.id)}>削除</button></div>
        </div>
      ))}</div>}
    </section>
  );
}
