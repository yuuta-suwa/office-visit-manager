-- Reservation cancel/edit with a required reason. Cancelling keeps the row
-- (status='cancelled') instead of deleting it, and both cancel and edit are
-- written to reservation_audit_logs (already created by 002, unused until now).
-- Requires schema.sql + 002_office_community_v2.sql (reservations.status,
-- reservation_audit_logs, consume_rate_limit).

-- The existing overlap check never looked at status, so a cancelled
-- reservation would still block a new one for the same time slot. This must
-- be fixed together with cancel_reservation, or cancelling would not
-- actually free up the slot. Signature is unchanged (4 args, same types),
-- so CREATE OR REPLACE safely replaces the existing function in place.
create or replace function public.validate_reservation_window(
  p_visit_date date,
  p_start_time time,
  p_end_time time,
  p_ignore_id uuid default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_start_time >= p_end_time then raise exception 'End time must be after start time'; end if;
  if p_visit_date < v_today or p_visit_date > (v_today + interval '1 month')::date then
    raise exception 'Reservations can be made from today through one month ahead';
  end if;

  if exists (
    select 1 from public.reservations r
    where r.user_id = v_uid
      and r.visit_date = p_visit_date
      and r.status = 'active'
      and (p_ignore_id is null or r.id <> p_ignore_id)
      and r.start_time < p_end_time
      and r.end_time > p_start_time
  ) then
    raise exception 'This reservation overlaps another reservation';
  end if;
end;
$$;

create or replace function public.cancel_reservation(p_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.reservations%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_reason, '')) = '' then raise exception 'Cancellation reason is required'; end if;
  perform public.consume_rate_limit('reservation_write', 30, 60);

  select * into v_row from public.reservations
  where id = p_id and user_id = v_uid and status = 'active'
  for update;
  if not found then raise exception 'Reservation not found or not owned by current user'; end if;

  update public.reservations
  set status = 'cancelled', updated_at = now()
  where id = p_id;

  insert into public.reservation_audit_logs(reservation_id, changed_by, old_values, new_values, reason)
  values (
    p_id, v_uid,
    to_jsonb(v_row),
    jsonb_build_object('status', 'cancelled'),
    left(trim(p_reason), 500)
  );
end;
$$;

-- update_reservation now requires a reason and logs it. Adding a trailing
-- param changes the argument-type signature, so CREATE OR REPLACE would
-- register a second overload instead of replacing the old one (the same
-- ambiguous-call problem found earlier with create_event_with_members).
-- Drop the old 5-arg signature first.
drop function if exists public.update_reservation(uuid, date, time, time, text);

create function public.update_reservation(
  p_id uuid,
  p_visit_date date,
  p_start_time time,
  p_end_time time,
  p_note text default '',
  p_reason text default ''
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.reservations%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_reason, '')) = '' then raise exception 'Edit reason is required'; end if;
  perform public.consume_rate_limit('reservation_write', 30, 60);

  select * into v_row from public.reservations
  where id = p_id and user_id = v_uid and status = 'active'
  for update;
  if not found then raise exception 'Reservation not found or not owned by current user'; end if;

  perform public.validate_reservation_window(p_visit_date, p_start_time, p_end_time, p_id);

  update public.reservations
  set visit_date = p_visit_date,
      start_time = p_start_time,
      end_time = p_end_time,
      note = left(coalesce(p_note, ''), 500),
      updated_at = now()
  where id = p_id and user_id = v_uid;

  insert into public.reservation_audit_logs(reservation_id, changed_by, old_values, new_values, reason)
  values (
    p_id, v_uid,
    to_jsonb(v_row),
    jsonb_build_object(
      'visit_date', p_visit_date, 'start_time', p_start_time,
      'end_time', p_end_time, 'note', left(coalesce(p_note, ''), 500)
    ),
    left(trim(p_reason), 500)
  );
end;
$$;

-- Hard delete is retired in favor of cancel_reservation (keeps history).
-- The function is left in place (not dropped) in case anything still
-- references it, but it can no longer be called through the API.
revoke execute on function public.delete_reservation(uuid) from authenticated;

revoke execute on function public.cancel_reservation(uuid, text) from public, anon;
revoke execute on function public.update_reservation(uuid, date, time, time, text, text) from public, anon;
grant execute on function public.cancel_reservation(uuid, text) to authenticated;
grant execute on function public.update_reservation(uuid, date, time, time, text, text) to authenticated;
