-- LINE integration foundations. Additive; no existing rows/roles change.
-- Requires 002 (profiles.line_user_id, notification_group_members,
-- event_notification_members, report_recipients, notification_logs) and
-- 005 (venue participation).
--
-- Three new RPCs:
-- 1) record_event_response_via_service: the LINE webhook has no Supabase
--    Auth session for the replying member (LINE authenticates the user, not
--    Supabase), so it cannot use respond_to_event's auth.uid()-based checks.
--    This mirrors respond_to_event's validation but takes an explicit
--    p_member_id and is restricted to the service role only (never granted
--    to anon/authenticated/public) -- only the server backend, calling with
--    the Supabase service role key, may act on a member's behalf this way.
-- 2) event_notification_targets / event_report_recipients: read-only rosters
--    (member_id, full_name, line_user_id) for the two notification
--    audiences that already exist as separate tables since 002
--    (event_notification_members vs report_recipients) -- kept separate
--    here too, so invite pushes and report pushes never reuse one list.
-- 3) log_notification: notification_logs (002) had no INSERT policy/grant at
--    all; this lets an authenticated key_manager/admin record the outcome of
--    a send they triggered themselves.

create or replace function public.record_event_response_via_service(
  p_member_id uuid,
  p_event_id uuid,
  p_participation_type public.event_participation_type,
  p_planned_arrival time default null,
  p_planned_departure time default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_event public.events;
  v_arrival time := p_planned_arrival;
begin
  if p_member_id is null or p_event_id is null or p_participation_type is null then
    raise exception 'member, event and participation type are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_member_id and active = true) then
    raise exception 'Active member required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.event_members where event_id = p_event_id and member_id = p_member_id) then
    raise exception 'Not an event member' using errcode = '42501';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found' using errcode = '22023'; end if;

  -- LINE replies are single-tap buttons with no time picker; default the
  -- arrival to the event's own start time (Asia/Tokyo) instead of failing,
  -- unlike the web form which always collects an explicit time.
  if p_participation_type = 'office' and v_arrival is null then
    v_arrival := (v_event.starts_at at time zone 'Asia/Tokyo')::time;
  end if;
  if p_participation_type = 'zoom' and (v_event.office_required or not v_event.zoom_allowed) then
    raise exception 'Zoom participation is not available for this event' using errcode = '22023';
  end if;
  if p_participation_type = 'venue' and (v_event.office_required or not v_event.venue_allowed) then
    raise exception 'Venue participation is not available for this event' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.event_responses
    where event_id = p_event_id and member_id = p_member_id and attendance_confirmed
  ) then
    raise exception 'Attendance is already confirmed; ask a key manager or admin to undo confirmation first' using errcode = '22023';
  end if;

  insert into public.event_responses(event_id, member_id, participation_type, planned_arrival, planned_departure, responded_at)
  values (
    p_event_id, p_member_id, p_participation_type,
    case when p_participation_type = 'office' then v_arrival end,
    case when p_participation_type = 'office' then p_planned_departure end,
    now()
  )
  on conflict (event_id, member_id) do update set
    participation_type = excluded.participation_type,
    planned_arrival = excluded.planned_arrival,
    planned_departure = excluded.planned_departure,
    responded_at = now();
end;
$$;

revoke execute on function public.record_event_response_via_service(
  uuid, uuid, public.event_participation_type, time, time
) from public, anon, authenticated;

create or replace function public.event_notification_targets(p_event_id uuid)
returns table(member_id uuid, full_name text, line_user_id text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.is_key_manager_or_admin() is not true then
    raise exception 'Key manager or admin role required' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.line_user_id
    from public.event_notification_members enm
    join public.profiles p on p.id = enm.member_id and p.active = true
    where enm.event_id = p_event_id and enm.enabled = true
    order by p.full_name;
end;
$$;

create or replace function public.event_report_recipients(p_event_id uuid)
returns table(member_id uuid, full_name text, line_user_id text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.is_key_manager_or_admin() is not true then
    raise exception 'Key manager or admin role required' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.line_user_id
    from public.report_recipients rr
    join public.profiles p on p.id = rr.member_id and p.active = true
    where rr.event_id = p_event_id and rr.enabled = true
    order by p.full_name;
end;
$$;

revoke execute on function public.event_notification_targets(uuid) from public, anon;
revoke execute on function public.event_report_recipients(uuid) from public, anon;
grant execute on function public.event_notification_targets(uuid) to authenticated;
grant execute on function public.event_report_recipients(uuid) to authenticated;

create or replace function public.log_notification(
  p_event_id uuid,
  p_member_id uuid,
  p_notification_type text,
  p_destination text,
  p_result text,
  p_error text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.is_key_manager_or_admin() is not true then
    raise exception 'Key manager or admin role required' using errcode = '42501';
  end if;
  insert into public.notification_logs(event_id, member_id, notification_type, destination, sent_at, result, error)
  values (
    p_event_id, p_member_id,
    left(coalesce(p_notification_type, ''), 50),
    left(coalesce(p_destination, ''), 200),
    case when p_result = 'sent' then now() else null end,
    left(coalesce(p_result, 'pending'), 20),
    left(p_error, 500)
  );
end;
$$;

revoke execute on function public.log_notification(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.log_notification(uuid, uuid, text, text, text, text) to authenticated;
