"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { createClient } from "@/lib/supabase/client";
import { formatTokyoDateTime, shortTime, tokyoDateString } from "@/lib/date";
import { buildEventReportText } from "@/lib/eventReport";
import type {
  EventAttendanceRow,
  EventItem,
  EventResponse,
  Profile,
} from "@/lib/types";

type AttendanceRow = EventAttendanceRow;

const blank = () => ({
  title: "",
  date: "",
  start: "21:00",
  end: "23:00",
  office_required: false,
  zoom_allowed: true,
  venue_allowed: false,
  venue_name: "",
  description: "",
});

export default function EventManager({
  currentUser,
}: {
  currentUser: Profile;
}) {
  const supabase = createClient();

  const canManage = currentUser.role === "admin";

  const canConfirm =
    currentUser.role === "admin" ||
    currentUser.role === "key_manager";

  const [events, setEvents] =
    useState<EventItem[]>([]);

  const [responses, setResponses] = useState<
    Record<string, EventResponse>
  >({});

  const [members, setMembers] =
    useState<Profile[]>([]);

  const [selected, setSelected] =
    useState<string[]>([]);

  const [form, setForm] = useState(blank());

  const [
    openedEventId,
    setOpenedEventId,
  ] = useState<string | null>(null);

  const [attendance, setAttendance] =
    useState<AttendanceRow[]>([]);

  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reportFallback, setReportFallback] = useState<string | null>(null);
  const [lineBusy, setLineBusy] = useState(false);

  const eventById = useMemo(
    () =>
      new Map(
        events.map((event) => [
          event.id,
          event,
        ])
      ),
    [events]
  );

  const openedEvent = openedEventId ? eventById.get(openedEventId) : undefined;
  const canConfirmToday = !!openedEvent &&
    tokyoDateString() >= tokyoDateString(new Date(openedEvent.starts_at)) &&
    tokyoDateString() <= tokyoDateString(new Date(openedEvent.ends_at));

  const load = useCallback(async () => {
    setError("");

    const {
      data: eventData,
      error: eventError,
    } = await supabase
      .from("events")
      .select(
        "id,title,starts_at,ends_at,office_required,zoom_allowed,venue_allowed,venue_name,description"
      )
      .gte(
        "ends_at",
        new Date().toISOString()
      )
      .order("starts_at");

    if (eventError) {
      setError(eventError.message);
      return;
    }

    const {
      data: responseData,
      error: responseError,
    } = await supabase
      .from("event_responses")
      .select(
        "event_id,participation_type,planned_arrival,planned_departure,attendance_confirmed"
      )
      .eq(
        "member_id",
        currentUser.id
      );

    if (responseError) {
      setError(responseError.message);
      return;
    }

    setEvents(
      (eventData ?? []) as EventItem[]
    );

    setResponses(
      Object.fromEntries(
        (
          (responseData ??
            []) as EventResponse[]
        ).map((response) => [
          response.event_id,
          response,
        ])
      )
    );

    if (canManage) {
      const {
        data,
        error,
      } = await supabase
        .from("profiles")
        .select(
          "id,full_name,role,active,team,jurisdiction"
        )
        .eq("active", true)
        .order("full_name");

      if (error) {
        setError(error.message);
      } else {
        setMembers(
          (data ?? []) as Profile[]
        );
      }
    }
  }, [
    canManage,
    currentUser.id,
    supabase,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(
    event: EventItem,
    type: EventResponse["participation_type"]
  ) {
    setError("");
    setMessage("");

    const previous =
      responses[event.id];

    const arrival =
      type === "office"
        ? previous?.planned_arrival
          ? shortTime(
              previous.planned_arrival
            )
          : new Intl.DateTimeFormat(
              "en-GB",
              {
                timeZone:
                  "Asia/Tokyo",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              }
            ).format(
              new Date(
                event.starts_at
              )
            )
        : null;

    const { error } =
      await supabase.rpc(
        "respond_to_event",
        {
          p_event_id: event.id,
          p_participation_type:
            type,
          p_planned_arrival:
            arrival,
          p_planned_departure:
            null,
        }
      );

    if (error) {
      setError(error.message);
      return;
    }

    setMessage(
      "参加予定を保存しました。"
    );

    await load();
  }

  async function createEvent(
    e: FormEvent
  ) {
    e.preventDefault();

    setError("");
    setMessage("");

    if (
      !form.date ||
      !selected.length
    ) {
      setError(
        "開催日と参加対象者を入力してください。"
      );
      return;
    }

    const start = new Date(
      `${form.date}T${form.start}:00+09:00`
    ).toISOString();

    const end = new Date(
      `${form.date}T${form.end}:00+09:00`
    ).toISOString();

    const { error } =
      await supabase.rpc(
        "create_event_with_members",
        {
          p_title:
            form.title,
          p_event_type:
            "other",
          p_starts_at:
            start,
          p_ends_at:
            end,
          p_office_required:
            form.office_required,
          p_zoom_allowed:
            form.zoom_allowed,
          p_description:
            form.description,
          p_member_ids:
            selected,
          p_notification_member_ids:
            selected,
          p_report_recipient_ids:
            [currentUser.id],
          p_venue_allowed:
            form.venue_allowed,
          p_venue_name:
            form.venue_name,
        }
      );

    if (error) {
      setError(error.message);
      return;
    }

    setForm(blank());
    setSelected([]);

    setMessage(
      "イベントを作成しました。"
    );

    await load();
  }

  async function openAttendance(
    eventId: string
  ) {
    if (!canConfirm || attendanceBusy) return;
    setError("");
    setMessage("");
    setReportFallback(null);
    setOpenedEventId(null);
    setAttendance([]);
    setAttendanceBusy(true);
    try {
      const { data, error } = await supabase.rpc("event_attendance_admin", { p_event_id: eventId });
      if (error) { setError(error.message); return; }
      setAttendance((data ?? []) as AttendanceRow[]);
      setOpenedEventId(eventId);
    } catch {
      setError("名簿を取得できませんでした。再度お試しください。");
    } finally { setAttendanceBusy(false); }
  }

  async function confirm(row: AttendanceRow, checked: boolean) {
    if (!canConfirm || !openedEventId || attendanceBusy) return;
    const eventId = openedEventId;
    setError("");
    setAttendanceBusy(true);
    try {
      const { error } = await supabase.rpc("confirm_event_attendance", {
        p_event_id: eventId, p_member_id: row.member_id, p_confirmed: checked,
      });
      if (error) { setError(error.message); return; }
      const { data, error: reloadError } = await supabase.rpc("event_attendance_admin", { p_event_id: eventId });
      if (reloadError) {
        setOpenedEventId(null); setAttendance([]);
        setError("参加確認は保存されましたが、名簿を再取得できませんでした。名簿を開き直してください。");
        return;
      }
      setAttendance((data ?? []) as AttendanceRow[]);
      await load();
    } catch {
      setOpenedEventId(null); setAttendance([]);
      setError("通信結果を確認できませんでした。名簿を開き直して保存状態を確認してください。");
    } finally { setAttendanceBusy(false); }
  }

  function reportText(rows: AttendanceRow[] = attendance) {
    if (!openedEventId) return "";
    const event = eventById.get(openedEventId);
    if (!event) return "";
    return buildEventReportText(event, rows);
  }

  async function copyReport() {
    if (attendanceBusy || !openedEventId) return;
    const eventId = openedEventId;
    setError("");
    setMessage("");
    setReportFallback(null);
    setAttendanceBusy(true);
    try {
      const { data, error } = await supabase.rpc(
        "event_attendance_admin",
        { p_event_id: eventId }
      );

      if (error) {
        setError(
          "最新の名簿を取得できなかったため、コピーを中止しました。"
        );
        return;
      }

      const freshRows = (data ?? []) as AttendanceRow[];
      setAttendance(freshRows);
      const text = reportText(freshRows);

      if (
        !navigator.clipboard ||
        !navigator.clipboard.writeText
      ) {
        setReportFallback(text);
        setMessage(
          "この端末では自動コピーできません。下の文章を選択してコピーしてください。"
        );
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        setMessage(
          "社長報告文をコピーしました。"
        );
      } catch {
        setReportFallback(text);
        setError(
          "自動コピーに失敗しました。下の文章を選択してコピーしてください。"
        );
      }
    } catch {
      setError(
        "最新の名簿を取得できなかったため、コピーを中止しました。"
      );
    } finally {
      setAttendanceBusy(false);
    }
  }

  async function notifyEventByLine(eventId: string) {
    if (lineBusy) return;
    setError(""); setMessage(""); setLineBusy(true);
    try {
      const res = await fetch("/api/line/notify-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "LINE通知の送信に失敗しました。"); return; }
      setMessage(`LINE通知：送信${data.sent}件／未連携${data.skipped}件／失敗${data.failed}件`);
    } catch {
      setError("LINE通知の送信結果を確認できませんでした。");
    } finally {
      setLineBusy(false);
    }
  }

  async function sendReportByLine() {
    if (lineBusy || !openedEventId) return;
    setError(""); setMessage(""); setLineBusy(true);
    try {
      const res = await fetch("/api/line/send-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: openedEventId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "LINEへの報告送信に失敗しました。"); return; }
      setMessage(`LINE報告：送信${data.sent}件／未連携${data.skipped}件／失敗${data.failed}件`);
    } catch {
      setError("LINE報告の送信結果を確認できませんでした。");
    } finally {
      setLineBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter(
            (memberId) =>
              memberId !== id
          )
        : [...prev, id]
    );
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>イベント参加</h2>

        <span className="badge">
          {canManage
            ? "管理"
            : "自分の対象イベント"}
        </span>
      </div>

      {error && (
        <div className="error">
          {error}
        </div>
      )}

      {message && (
        <div className="success">
          {message}
        </div>
      )}

      {canManage && (
        <form
          onSubmit={
            createEvent
          }
          className="event-form"
        >
          <h3>
            イベントを作成
          </h3>

          <div className="form-grid">
            <div className="field full">
              <label>
                イベント名
              </label>

              <input
                required
                value={
                  form.title
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    title:
                      e.target
                        .value,
                  })
                }
                placeholder="LIFE STAGE 1.0 / 2.0"
              />
            </div>

            <div className="field">
              <label>
                開催日
              </label>

              <input
                type="date"
                required
                value={
                  form.date
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    date:
                      e.target
                        .value,
                  })
                }
              />
            </div>

            <div className="field">
              <label>
                時間
              </label>

              <div className="actions">
                <input
                  type="time"
                  value={
                    form.start
                  }
                  onChange={(
                    e
                  ) =>
                    setForm({
                      ...form,
                      start:
                        e.target
                          .value,
                    })
                  }
                />

                <input
                  type="time"
                  value={
                    form.end
                  }
                  onChange={(
                    e
                  ) =>
                    setForm({
                      ...form,
                      end:
                        e.target
                          .value,
                    })
                  }
                />
              </div>
            </div>

            <div className="field full">
              <label>
                会場名（会場参加を許可する場合）
              </label>

              <input
                value={
                  form.venue_name
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    venue_name:
                      e.target
                        .value,
                  })
                }
                placeholder="○○会場"
              />
            </div>

            <div className="field full">
              <label>
                参加対象者（
                {
                  selected.length
                }
                名選択）
              </label>

              <div className="member-picker">
                {members.map(
                  (
                    member
                  ) => (
                    <label
                      key={
                        member.id
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(
                          member.id
                        )}
                        onChange={() =>
                          toggle(
                            member.id
                          )
                        }
                      />

                      {" "}
                      {
                        member.full_name
                      }
                    </label>
                  )
                )}
              </div>
            </div>

            <div className="field full">
              <label>
                説明（任意）
              </label>

              <textarea
                value={
                  form.description
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    description:
                      e.target
                        .value,
                  })
                }
              />
            </div>
          </div>

          <div className="actions">
            <label>
              <input
                type="checkbox"
                checked={
                  form.office_required
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    office_required:
                      e.target
                        .checked,
                  })
                }
              />

              {" "}
              オフィス参加必須
            </label>

            <label>
              <input
                type="checkbox"
                checked={
                  form.zoom_allowed
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    zoom_allowed:
                      e.target
                        .checked,
                  })
                }
              />

              {" "}
              Zoom参加可
            </label>

            <label>
              <input
                type="checkbox"
                checked={
                  form.venue_allowed
                }
                onChange={(
                  e
                ) =>
                  setForm({
                    ...form,
                    venue_allowed:
                      e.target
                        .checked,
                  })
                }
              />

              {" "}
              会場参加可
            </label>

            <button
              type="submit"
              className="btn btn-primary"
            >
              作成する
            </button>
          </div>
        </form>
      )}

      {!events.length ? (
        <p className="muted">
          現在、回答が必要なイベントはありません。
        </p>
      ) : (
        <div className="list">
          {events.map(
            (event) => {
              const response =
                responses[
                  event.id
                ];

              return (
                <div
                  className="row"
                  key={
                    event.id
                  }
                >
                  <div className="row-main">
                    <div className="row-title">
                      {
                        event.title
                      }
                    </div>

                    <div className="row-note">
                      {formatTokyoDateTime(
                        event.starts_at
                      )}
                      〜
                      {formatTokyoDateTime(
                        event.ends_at
                      )}

                      {response?.attendance_confirmed
                        ? "　⭕️参加確認済"
                        : ""}
                    </div>

                    <div className="event-answer">
                      <span className="event-answer-label">
                        現在の回答：
                      </span>

                      {!response
                        ? "未回答"
                        : response.participation_type ===
                            "office"
                          ? `オフィス参加${
                              response.planned_arrival
                                ? `　${shortTime(
                                    response.planned_arrival
                                  )}出社予定`
                                : ""
                            }`
                          : response.participation_type ===
                              "venue"
                            ? `会場参加${
                                event.venue_name
                                  ? `　${event.venue_name}`
                                  : ""
                              }`
                            : response.participation_type ===
                                "zoom"
                              ? "Zoom参加"
                              : "不参加"}
                    </div>
                  </div>

                  <div className="actions">
                    {canConfirm && (
                      <button
                        type="button"
                        className="btn attendance-open"
                        disabled={attendanceBusy}
                        onClick={() =>
                          openAttendance(
                            event.id
                          )
                        }
                      >
                        当日名簿
                      </button>
                    )}

                    {canManage && (
                      <button
                        type="button"
                        className="btn"
                        disabled={lineBusy}
                        onClick={() =>
                          notifyEventByLine(
                            event.id
                          )
                        }
                      >
                        LINEで通知
                      </button>
                    )}

                    <button
                      type="button"
                      className={
                        response?.participation_type ===
                        "office"
                          ? "btn btn-primary"
                          : "btn"
                      }
                      onClick={() =>
                        respond(
                          event,
                          "office"
                        )
                      }
                    >
                      オフィス
                    </button>

                    {event.zoom_allowed &&
                      !event.office_required && (
                        <button
                          type="button"
                          className={
                            response?.participation_type ===
                            "zoom"
                              ? "btn btn-primary"
                              : "btn"
                          }
                          onClick={() =>
                            respond(
                              event,
                              "zoom"
                            )
                          }
                        >
                          Zoom
                        </button>
                      )}

                    {event.venue_allowed &&
                      !event.office_required && (
                        <button
                          type="button"
                          className={
                            response?.participation_type ===
                            "venue"
                              ? "btn btn-primary"
                              : "btn"
                          }
                          onClick={() =>
                            respond(
                              event,
                              "venue"
                            )
                          }
                        >
                          会場
                        </button>
                      )}

                    <button
                      type="button"
                      className={
                        response?.participation_type ===
                        "absent"
                          ? "btn btn-danger"
                          : "btn"
                      }
                      onClick={() =>
                        respond(
                          event,
                          "absent"
                        )
                      }
                    >
                      不参加
                    </button>
                  </div>
                </div>
              );
            }
          )}
        </div>
      )}

      {canConfirm && openedEventId && (
        <div className="attendance-panel">
          <div className="section-head">
            <h3>
              {
                eventById.get(
                  openedEventId
                )?.title
              }
              ｜当日名簿
            </h3>

            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={attendanceBusy}
                onClick={
                  copyReport
                }
              >
                社長報告文をコピー
              </button>

              <button
                type="button"
                className="btn"
                disabled={lineBusy}
                onClick={sendReportByLine}
              >
                LINEへ報告を送信
              </button>

              <button
                type="button"
                className="btn"
                disabled={attendanceBusy}
                onClick={() => {
                  setOpenedEventId(
                    null
                  );
                  setReportFallback(
                    null
                  );
                }}
              >
                閉じる
              </button>
            </div>
          </div>

          {reportFallback !== null && (
            <div className="field full">
              <label>
                手動コピー用の報告文
              </label>

              <textarea
                readOnly
                rows={10}
                value={reportFallback}
                onFocus={(e) =>
                  e.target.select()
                }
              />
            </div>
          )}

          <p className="muted">⭕️は実際の参加確認済みを示します。参加確認は開催日のみ可能です。</p>
          {!attendance.length && <p className="muted">対象者はいません。</p>}
          {attendance.map(
            (row) => (
              <div
                className="row"
                key={
                  row.member_id
                }
              >
                <div className="row-main">
                  <div className="row-title">
                    {
                      row.full_name
                    }

                    {row.attendance_confirmed
                      ? " ⭕️"
                      : ""}
                  </div>

                  <div className="row-note">
                    {row.participation_type ===
                    "office"
                      ? `オフィス ${
                          row.planned_arrival
                            ? shortTime(
                                row.planned_arrival
                              )
                            : ""
                        }`
                      : row.participation_type ===
                          "venue"
                        ? `会場 ${
                            openedEvent?.venue_name ??
                            ""
                          }`
                        : row.participation_type ===
                            "zoom"
                          ? "Zoom"
                          : row.participation_type ===
                              "absent"
                            ? "不参加"
                            : "未回答"}
                  </div>
                </div>

                <button
                  type="button"
                  className={
                    row.attendance_confirmed
                      ? "btn btn-success"
                      : "btn"
                  }
                  disabled={
                    attendanceBusy || (!row.attendance_confirmed && (
                      !row.participation_type || row.participation_type === "absent" ||
                      !canConfirmToday
                    ))
                  }
                  onClick={() =>
                    confirm(
                      row,
                      !row.attendance_confirmed
                    )
                  }
                >
                  {row.attendance_confirmed
                    ? "確認を戻す"
                    : "⭕️参加確認"}
                </button>
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}