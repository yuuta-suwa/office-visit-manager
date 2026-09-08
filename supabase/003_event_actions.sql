-- Event management actions. Run after 002_office_community_v2.sql.

create or replace function public.create_event_with_members(
  p_title text, p_event_type public.event_type, p_starts_at timestamptz, p_ends_at timestamptz,
  p_office_required boolean, p_zoom_allowed boolean, p_description text,
  p_member_ids uuid[] default '{}', p_notification_member_ids uuid[] default '{}', p_report_recipient_ids uuid[] default '{}'
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin role required'; end if;
  if trim(p_title) = '' or char_length(p_title) > 120 then raise exception 'Invalid title'; end if;
  if p_starts_at >= p_ends_at then raise exception 'End time must be after start time'; end if;
  insert into public.events(title,event_type,starts_at,ends_at,office_required,zoom_allowed,description,created_by)
  values(trim(p_title),p_event_type,p_starts_at,p_ends_at,coalesce(p_office_required,false),coalesce(p_zoom_allowed,false),left(coalesce(p_description,''),2000),auth.uid()) returning id into v_id;
  insert into public.event_members(event_id,member_id) select v_id, id from public.profiles where id = any(p_member_ids) and active = true;
  insert into public.event_notification_members(event_id,member_id,enabled) select v_id, id, true from public.profiles where id = any(p_notification_member_ids) and active = true;
  insert into public.report_recipients(event_id,member_id,enabled) select v_id, id, true from public.profiles where id = any(p_report_recipient_ids) and active = true;
  return v_id;
end;
$$;

create or replace function public.respond_to_event(
  p_event_id uuid, p_participation_type public.event_participation_type,
  p_planned_arrival time default null, p_planned_departure time default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active_member() then raise exception 'Active member required'; end if;
  if not exists(select 1 from public.event_members where event_id=p_event_id and member_id=auth.uid()) then raise exception 'Not an event member'; end if;
  if p_participation_type='office' and p_planned_arrival is null then raise exception 'Arrival time is required for office participation'; end if;
  insert into public.event_responses(event_id,member_id,participation_type,planned_arrival,planned_departure,responded_at)
  values(p_event_id,auth.uid(),p_participation_type,p_planned_arrival,p_planned_departure,now())
  on conflict(event_id,member_id) do update set participation_type=excluded.participation_type,planned_arrival=excluded.planned_arrival,planned_departure=excluded.planned_departure,responded_at=now();
end;
$$;

create or replace function public.confirm_event_attendance(p_event_id uuid, p_member_id uuid, p_confirmed boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_key_manager_or_admin() then raise exception 'Key manager or admin role required'; end if;
  update public.event_responses set attendance_confirmed=p_confirmed, actual_joined_at=case when p_confirmed then coalesce(actual_joined_at,now()) else null end, confirmed_by=case when p_confirmed then auth.uid() else null end where event_id=p_event_id and member_id=p_member_id;
  if not found then raise exception 'No response found for this member'; end if;
end;
$$;

create or replace function public.event_attendance_admin(p_event_id uuid)
returns table(member_id uuid, full_name text, participation_type public.event_participation_type, planned_arrival time, planned_departure time, attendance_confirmed boolean, responded_at timestamptz)
language sql stable security definer set search_path=public as $$
  select em.member_id,p.full_name,er.participation_type,er.planned_arrival,er.planned_departure,coalesce(er.attendance_confirmed,false),er.responded_at
  from public.event_members em join public.profiles p on p.id=em.member_id left join public.event_responses er on er.event_id=em.event_id and er.member_id=em.member_id
  where em.event_id=p_event_id and public.is_key_manager_or_admin() order by p.full_name
$$;

grant execute on function public.create_event_with_members(text,public.event_type,timestamptz,timestamptz,boolean,boolean,text,uuid[],uuid[],uuid[]) to authenticated;
grant execute on function public.respond_to_event(uuid,public.event_participation_type,time,time) to authenticated;
grant execute on function public.confirm_event_attendance(uuid,uuid,boolean) to authenticated;
grant execute on function public.event_attendance_admin(uuid) to authenticated;
