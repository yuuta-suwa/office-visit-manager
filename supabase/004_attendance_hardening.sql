-- REVIEW REQUIRED: production migration. Apply only after reviewing live function definitions.
-- Requires schema + v2 tables/helpers + event action RPCs. No rows are deleted or roles reassigned.
begin;

-- A missing/inactive profile must return false, never NULL (IF NOT NULL does not reject).
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role() = 'admin'::public.user_role, false)
$$;
create or replace function public.is_key_manager_or_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role() in ('key_manager'::public.user_role, 'admin'::public.user_role), false)
$$;

create or replace function public.event_attendance_admin(p_event_id uuid)
returns table(member_id uuid, full_name text, participation_type public.event_participation_type, planned_arrival time, planned_departure time, attendance_confirmed boolean, responded_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_key_manager_or_admin() is not true then
    raise exception 'Key manager or admin role required' using errcode = '42501';
  end if;
  return query
    select em.member_id, p.full_name, er.participation_type, er.planned_arrival,
      er.planned_departure, coalesce(er.attendance_confirmed, false), er.responded_at
    from public.event_members em
    join public.profiles p on p.id = em.member_id
    left join public.event_responses er on er.event_id = em.event_id and er.member_id = em.member_id
    where em.event_id = p_event_id
    order by p.full_name, em.member_id;
end;
$$;

create or replace function public.confirm_event_attendance(p_event_id uuid, p_member_id uuid, p_confirmed boolean)
returns void language plpgsql security definer set search_path = public as $$
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
      and (not p_confirmed or er.participation_type in ('office', 'zoom'))
      and exists (select 1 from public.event_members em where em.event_id = er.event_id and em.member_id = er.member_id);
  if not found then raise exception 'No eligible event response found' using errcode = '22023'; end if;
end;
$$;

-- Only affects future accounts; preserve existing profile rows and the existing trigger.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, full_name, role)
  values(new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(new.email, ''), '@', 1)), 'member')
  on conflict(id) do nothing;
  return new;
end;
$$;

revoke execute on function public.is_admin(), public.is_key_manager_or_admin(), public.event_attendance_admin(uuid), public.confirm_event_attendance(uuid,uuid,boolean), public.handle_new_user() from public, anon;
grant execute on function public.is_admin(), public.is_key_manager_or_admin(), public.event_attendance_admin(uuid), public.confirm_event_attendance(uuid,uuid,boolean) to authenticated;
commit;
