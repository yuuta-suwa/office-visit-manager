-- Office Community v2 / P0-P1 migration
-- Run only after the existing supabase/schema.sql has been applied.
-- This migration is additive where possible and replaces the MVP's privacy-breaking RLS policies.

-- Enum values must be committed before they can be used below. Do not wrap this file in one transaction.
alter type public.user_role add value if not exists 'member';
alter type public.user_role add value if not exists 'key_manager';
alter type public.user_role add value if not exists 'admin';

alter table public.profiles
  add column if not exists line_user_id text unique,
  add column if not exists team text not null default '',
  add column if not exists jurisdiction text not null default '',
  add column if not exists active boolean not null default true;

-- Existing roles are retained only long enough to migrate safely.
update public.profiles set role = 'member' where role = 'staff';
update public.profiles set role = 'admin' where role = 'master';
alter table public.profiles alter column role set default 'member';

alter table public.reservations
  add column if not exists planned_activity text,
  add column if not exists purpose text,
  add column if not exists status text not null default 'active'
    check (status in ('active', 'cancelled'));

create table if not exists public.reservation_audit_logs (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  changed_by uuid not null references public.profiles(id),
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  reason text not null default '',
  changed_at timestamptz not null default now()
);

create table if not exists public.unlock_schedules (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time time not null,
  end_time time not null,
  key_manager_id uuid not null references public.profiles(id),
  memo text not null default '',
  created_at timestamptz not null default now(),
  check (start_time < end_time)
);

do $$ begin
  create type public.event_participation_type as enum ('office', 'zoom', 'absent');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type public.event_type as enum ('life_stage_1_2', 'life_stage_3', 'general_meeting', 'links_roots', 'other');
exception when duplicate_object then null;
end $$;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  event_type public.event_type not null default 'other',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  office_required boolean not null default false,
  zoom_allowed boolean not null default false,
  response_deadline timestamptz,
  auto_report_enabled boolean not null default false,
  description text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at)
);

create table if not exists public.event_members (
  event_id uuid not null references public.events(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

create table if not exists public.event_responses (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  participation_type public.event_participation_type not null,
  planned_arrival time,
  planned_departure time,
  responded_at timestamptz not null default now(),
  actual_joined_at timestamptz,
  actual_left_at timestamptz,
  attendance_confirmed boolean not null default false,
  confirmed_by uuid references public.profiles(id),
  unique (event_id, member_id),
  check (planned_arrival is null or planned_departure is null or planned_arrival < planned_departure)
);

create table if not exists public.notification_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.notification_group_members (
  group_id uuid not null references public.notification_groups(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  primary key (group_id, member_id)
);
create table if not exists public.event_notification_members (
  event_id uuid not null references public.events(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  primary key (event_id, member_id)
);
create table if not exists public.report_recipients (
  event_id uuid not null references public.events(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  primary key (event_id, member_id)
);
create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  member_id uuid references public.profiles(id) on delete set null,
  notification_type text not null,
  destination text not null,
  sent_at timestamptz,
  result text not null default 'pending',
  error text,
  created_at timestamptz not null default now()
);

create index if not exists events_starts_at_idx on public.events(starts_at);
create index if not exists event_responses_event_idx on public.event_responses(event_id);
create index if not exists reservations_active_date_idx on public.reservations(visit_date, start_time) where status = 'active';

create or replace function public.current_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active = true
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() = 'admin'::public.user_role
$$;
create or replace function public.is_key_manager_or_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('key_manager'::public.user_role, 'admin'::public.user_role)
$$;
create or replace function public.is_active_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and active = true)
$$;

-- Compatibility for the existing UI: office opening may be operated by a key manager or admin.
create or replace function public.is_master(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = p_user_id and active = true and role in ('key_manager', 'admin'))
$$;

create or replace function public.set_user_role(p_user_id uuid, p_role public.user_role)
returns void language plpgsql security definer set search_path = public as $$
declare v_current public.user_role; v_admin_count integer;
begin
  if not public.is_admin() then raise exception 'Admin role required'; end if;
  select role into v_current from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User not found'; end if;
  if v_current = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count from public.profiles where role = 'admin' and active = true;
    if v_admin_count <= 1 then raise exception 'At least one active admin is required'; end if;
  end if;
  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;
end;
$$;

-- Safe aggregate for MEMBER. It deliberately has no names, IDs, notes, or individual times.
create or replace function public.office_calendar_summary(p_date date)
returns table (time_slot time, planned_count bigint, has_unlock boolean)
language sql stable security definer set search_path = public as $$
  select r.start_time, count(*)::bigint,
    exists(select 1 from public.unlock_schedules u where u.date = p_date and u.start_time <= r.start_time and u.end_time > r.start_time)
  from public.reservations r
  where r.visit_date = p_date and r.status = 'active'
  group by r.start_time
  order by r.start_time
$$;

-- Replace MVP RLS. MEMBER never receives another member's personal reservation or profile.
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_self_or_admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists "reservations_select_authenticated" on public.reservations;
create policy "reservations_select_by_role" on public.reservations for select to authenticated
  using (user_id = auth.uid() or public.is_key_manager_or_admin());
drop policy if exists "office_status_select_authenticated" on public.office_status;
create policy "office_status_active_member" on public.office_status for select to authenticated using (public.is_active_member());
drop policy if exists "logs_select_authenticated" on public.open_close_logs;
create policy "logs_key_manager_or_admin" on public.open_close_logs for select to authenticated using (public.is_key_manager_or_admin());

alter table public.reservation_audit_logs enable row level security;
alter table public.unlock_schedules enable row level security;
alter table public.events enable row level security;
alter table public.event_members enable row level security;
alter table public.event_responses enable row level security;
alter table public.notification_groups enable row level security;
alter table public.notification_group_members enable row level security;
alter table public.event_notification_members enable row level security;
alter table public.report_recipients enable row level security;
alter table public.notification_logs enable row level security;

create policy "audit_admin_only" on public.reservation_audit_logs for select to authenticated using (public.is_admin());
create policy "unlock_key_manager_or_admin" on public.unlock_schedules for select to authenticated using (public.is_key_manager_or_admin());
create policy "events_visible_to_members" on public.events for select to authenticated using (
  public.is_key_manager_or_admin() or exists(select 1 from public.event_members em where em.event_id = id and em.member_id = auth.uid())
);
create policy "event_members_self_or_admin" on public.event_members for select to authenticated using (member_id = auth.uid() or public.is_key_manager_or_admin());
create policy "event_responses_self_or_admin" on public.event_responses for select to authenticated using (member_id = auth.uid() or public.is_key_manager_or_admin());
create policy "notification_groups_admin" on public.notification_groups for select to authenticated using (public.is_admin());
create policy "notification_group_members_admin" on public.notification_group_members for select to authenticated using (public.is_admin());
create policy "event_notification_members_admin" on public.event_notification_members for select to authenticated using (public.is_admin());
create policy "report_recipients_admin" on public.report_recipients for select to authenticated using (public.is_admin());
create policy "notification_logs_admin" on public.notification_logs for select to authenticated using (public.is_admin());

revoke execute on function public.current_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_key_manager_or_admin() from public, anon;
revoke execute on function public.is_active_member() from public, anon;
revoke execute on function public.office_calendar_summary(date) from public, anon;
grant execute on function public.office_calendar_summary(date) to authenticated;
