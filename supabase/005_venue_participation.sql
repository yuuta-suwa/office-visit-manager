-- Venue participation (会場参加). Additive on top of 002/003/004.
-- Existing events/responses are untouched; venue_allowed defaults to false so
-- existing events keep working exactly as before this migration.
--
-- The enum value must be committed before it is used elsewhere in this file,
-- so it is the first statement here and this file is not wrapped in an
-- explicit BEGIN/COMMIT block (same convention as 002_office_community_v2.sql).
alter type public.event_participation_type add value if not exists 'venue';

alter table public.events
  add column if not exists venue_allowed boolean not null default false,
  add column if not exists venue_name text not null default '';

do $$ begin
  alter table public.events
    add constraint events_venue_name_length check (char_length(venue_name) <= 200);
exception when duplicate_object then null;
end $$;

-- respond_to_event: add venue handling and two invariants requested this round:
-- 1) venue/zoom cannot be used to substitute for a required office attendance;
-- 2) once a manager has confirmed actual attendance, the member can no longer
--    silently overwrite it via a new response (must ask a manager to undo first).
-- planned_arrival/planned_departure remain meaningful for office only.
create or replace function public.respond_to_event(
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
begin
  if not public.is_active_member() then raise exception 'Active member required'; end if;
  if not exists(select 1 from public.event_members where event_id = p_event_id and member_id = auth.uid()) then
    raise exception 'Not an event member';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;

  if p_participation_type = 'office' and p_planned_arrival is null then
    raise exception 'Arrival time is required for office participation';
  end if;
  if p_participation_type = 'zoom' and (v_event.office_required or not v_event.zoom_allowed) then
    raise exception 'Zoom participation is not available for this event';
  end if;
  if p_participation_type = 'venue' and (v_event.office_required or not v_event.venue_allowed) then
    raise exception 'Venue participation is not available for this event';
  end if;

  if exists (
    select 1 from public.event_responses
    where event_id = p_event_id and member_id = auth.uid() and attendance_confirmed
  ) then
    raise exception 'Attendance is already confirmed; ask a key manager or admin to undo confirmation first';
  end if;

  insert into public.event_responses(event_id, member_id, participation_type, planned_arrival, planned_departure, responded_at)
  values (
    p_event_id,
    auth.uid(),
    p_participation_type,
    case when p_participation_type = 'office' then p_planned_arrival end,
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

-- confirm_event_attendance: venue participation is now eligible for confirmation,
-- same as office/zoom. absent/unanswered/not-a-member remain ineligible.
create or replace function public.confirm_event_attendance(p_event_id uuid, p_member_id uuid, p_confirmed boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null or public.is_key_manager_or_admin() is not true then
    raise exception 'Key manager or admin role required' using errcode = '42501';
  end if;
  if p_confirmed is null then raise exception 'Confirmation value required' using errcode = '22023'; end if;
  if p_confirmed and not exists (
    select 1 from public.events e where e.id = p_event_id
      and (now() at time zone 'Asia/Tokyo')::date between
        (e.starts_at at time zone 'Asia/Tokyo')::date and (e.ends_at at time zone 'Asia/Tokyo')::date
  ) then raise exception 'Attendance can only be confirmed on event dates' using errcode = '22023'; end if;
  update public.event_responses er
    set attendance_confirmed = p_confirmed,
      actual_joined_at = case when p_confirmed then coalesce(er.actual_joined_at, now()) else null end,
      confirmed_by = case when p_confirmed then auth.uid() else null end
    where er.event_id = p_event_id and er.member_id = p_member_id
      and (not p_confirmed or er.participation_type in ('office', 'venue', 'zoom'))
      and exists (select 1 from public.event_members em where em.event_id = er.event_id and em.member_id = er.member_id);
  if not found then raise exception 'No eligible event response found' using errcode = '22023'; end if;
end;
$$;

-- create_event_with_members: adding trailing default params changes this
-- function's argument-type signature, so CREATE OR REPLACE would register a
-- second overload instead of replacing it (ambiguous with calls that rely on
-- the old trailing defaults). Drop the old 10-arg signature explicitly first;
-- this function has no independent production customization to preserve.
drop function if exists public.create_event_with_members(
  text, public.event_type, timestamptz, timestamptz, boolean, boolean, text, uuid[], uuid[], uuid[]
);

create function public.create_event_with_members(
  p_title text, p_event_type public.event_type, p_starts_at timestamptz, p_ends_at timestamptz,
  p_office_required boolean, p_zoom_allowed boolean, p_description text,
  p_member_ids uuid[] default '{}', p_notification_member_ids uuid[] default '{}', p_report_recipient_ids uuid[] default '{}',
  p_venue_allowed boolean default false, p_venue_name text default ''
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin role required'; end if;
  if trim(p_title) = '' or char_length(p_title) > 120 then raise exception 'Invalid title'; end if;
  if p_starts_at >= p_ends_at then raise exception 'End time must be after start time'; end if;
  if char_length(coalesce(p_venue_name, '')) > 200 then raise exception 'Invalid venue name'; end if;
  insert into public.events(title, event_type, starts_at, ends_at, office_required, zoom_allowed, venue_allowed, venue_name, description, created_by)
  values (
    trim(p_title), p_event_type, p_starts_at, p_ends_at,
    coalesce(p_office_required, false), coalesce(p_zoom_allowed, false),
    coalesce(p_venue_allowed, false), left(coalesce(p_venue_name, ''), 200),
    left(coalesce(p_description, ''), 2000), auth.uid()
  ) returning id into v_id;
  insert into public.event_members(event_id, member_id) select v_id, id from public.profiles where id = any(p_member_ids) and active = true;
  insert into public.event_notification_members(event_id, member_id, enabled) select v_id, id, true from public.profiles where id = any(p_notification_member_ids) and active = true;
  insert into public.report_recipients(event_id, member_id, enabled) select v_id, id, true from public.profiles where id = any(p_report_recipient_ids) and active = true;
  return v_id;
end;
$$;

revoke execute on function public.respond_to_event(uuid, public.event_participation_type, time, time) from public, anon;
revoke execute on function public.confirm_event_attendance(uuid, uuid, boolean) from public, anon;
revoke execute on function public.create_event_with_members(text, public.event_type, timestamptz, timestamptz, boolean, boolean, text, uuid[], uuid[], uuid[], boolean, text) from public, anon;

grant execute on function public.respond_to_event(uuid, public.event_participation_type, time, time) to authenticated;
grant execute on function public.confirm_event_attendance(uuid, uuid, boolean) to authenticated;
grant execute on function public.create_event_with_members(text, public.event_type, timestamptz, timestamptz, boolean, boolean, text, uuid[], uuid[], uuid[], boolean, text) to authenticated;
