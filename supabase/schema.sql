-- 来社管理アプリ MVP schema
-- Supabase SQL Editor で上から順に1回実行してください。

create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('master', 'staff');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.office_action as enum ('open', 'close');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role public.user_role not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.office_status (
  singleton_id smallint primary key default 1 check (singleton_id = 1),
  is_open boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

insert into public.office_status(singleton_id, is_open)
values (1, false)
on conflict (singleton_id) do nothing;

create table if not exists public.open_close_logs (
  id uuid primary key default gen_random_uuid(),
  action public.office_action not null,
  performed_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists open_close_logs_created_idx
  on public.open_close_logs(created_at desc);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  visit_date date not null,
  start_time time not null,
  end_time time not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_valid_time check (start_time < end_time),
  constraint reservations_note_length check (char_length(note) <= 500)
);

create index if not exists reservations_date_time_idx
  on public.reservations(visit_date, start_time);
create index if not exists reservations_user_date_idx
  on public.reservations(user_id, visit_date);

-- アプリ操作用の簡易レート制限（認証レート制限とは別）
create table if not exists public.action_rate_limits (
  user_id uuid not null references public.profiles(id) on delete cascade,
  action_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  primary key (user_id, action_key)
);

-- auth.users 作成時に staff profile を自動作成。
-- role はユーザー入力を信用せず必ず staff から開始する。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(new.email, ''), '@', 1)),
    'staff'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- schema適用前から存在するAuthユーザーもprofileへ補完。
insert into public.profiles(id, full_name, role)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(u.email, ''), '@', 1)),
  'staff'::public.user_role
from auth.users u
on conflict (id) do nothing;

create or replace function public.is_master(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = p_user_id and role = 'master'
  );
$$;

create or replace function public.consume_rate_limit(
  p_action_key text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.action_rate_limits%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select * into v_row
  from public.action_rate_limits
  where user_id = v_uid and action_key = p_action_key
  for update;

  if not found then
    insert into public.action_rate_limits(user_id, action_key, window_started_at, request_count)
    values (v_uid, p_action_key, now(), 1);
    return;
  end if;

  if v_row.window_started_at + make_interval(secs => p_window_seconds) <= now() then
    update public.action_rate_limits
    set window_started_at = now(), request_count = 1
    where user_id = v_uid and action_key = p_action_key;
    return;
  end if;

  if v_row.request_count >= p_limit then
    raise exception 'Too many requests. Please try again later.';
  end if;

  update public.action_rate_limits
  set request_count = request_count + 1
  where user_id = v_uid and action_key = p_action_key;
end;
$$;

-- 開閉状態変更とログ記録を1トランザクションで処理。
create or replace function public.set_office_state(p_is_open boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current boolean;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if not public.is_master(v_uid) then raise exception 'Master role required'; end if;
  perform public.consume_rate_limit('office_state', 10, 60);

  select is_open into v_current
  from public.office_status
  where singleton_id = 1
  for update;

  if v_current = p_is_open then
    raise exception 'Office is already in the requested state';
  end if;

  update public.office_status
  set is_open = p_is_open, updated_by = v_uid, updated_at = now()
  where singleton_id = 1;

  insert into public.open_close_logs(action, performed_by)
  values (case when p_is_open then 'open'::public.office_action else 'close'::public.office_action end, v_uid);
end;
$$;

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
      and (p_ignore_id is null or r.id <> p_ignore_id)
      and r.start_time < p_end_time
      and r.end_time > p_start_time
  ) then
    raise exception 'This reservation overlaps another reservation';
  end if;
end;
$$;

create or replace function public.create_reservation(
  p_visit_date date,
  p_start_time time,
  p_end_time time,
  p_note text default ''
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  perform public.consume_rate_limit('reservation_write', 30, 60);
  perform public.validate_reservation_window(p_visit_date, p_start_time, p_end_time, null);
  insert into public.reservations(user_id, visit_date, start_time, end_time, note)
  values (v_uid, p_visit_date, p_start_time, p_end_time, left(coalesce(p_note, ''), 500))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_reservation(
  p_id uuid,
  p_visit_date date,
  p_start_time time,
  p_end_time time,
  p_note text default ''
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform public.consume_rate_limit('reservation_write', 30, 60);
  if not exists(select 1 from public.reservations where id = p_id and user_id = v_uid) then
    raise exception 'Reservation not found or not owned by current user';
  end if;
  perform public.validate_reservation_window(p_visit_date, p_start_time, p_end_time, p_id);
  update public.reservations
  set visit_date = p_visit_date,
      start_time = p_start_time,
      end_time = p_end_time,
      note = left(coalesce(p_note, ''), 500),
      updated_at = now()
  where id = p_id and user_id = v_uid;
end;
$$;

create or replace function public.delete_reservation(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform public.consume_rate_limit('reservation_write', 30, 60);
  delete from public.reservations where id = p_id and user_id = v_uid;
  if not found then raise exception 'Reservation not found or not owned by current user'; end if;
end;
$$;

-- マスターのみユーザー権限変更可能。
create or replace function public.set_user_role(p_user_id uuid, p_role public.user_role)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_current public.user_role;
  v_master_count integer;
begin
  if not public.is_master(auth.uid()) then raise exception 'Master role required'; end if;
  perform public.consume_rate_limit('role_change', 20, 60);

  select role into v_current from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User not found'; end if;

  if v_current = 'master' and p_role = 'staff' then
    select count(*) into v_master_count from public.profiles where role = 'master';
    if v_master_count <= 1 then
      raise exception 'At least one master user is required';
    end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;
end;
$$;

-- RLS
alter table public.profiles enable row level security;
alter table public.office_status enable row level security;
alter table public.open_close_logs enable row level security;
alter table public.reservations enable row level security;
alter table public.action_rate_limits enable row level security;

-- 既存policy再作成用
DROP POLICY IF EXISTS "profiles_select_authenticated" ON public.profiles;
CREATE POLICY "profiles_select_authenticated" ON public.profiles
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "office_status_select_authenticated" ON public.office_status;
CREATE POLICY "office_status_select_authenticated" ON public.office_status
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "logs_select_authenticated" ON public.open_close_logs;
CREATE POLICY "logs_select_authenticated" ON public.open_close_logs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "reservations_select_authenticated" ON public.reservations;
CREATE POLICY "reservations_select_authenticated" ON public.reservations
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR visit_date = (now() at time zone 'Asia/Tokyo')::date
  );

-- 予約の直接INSERT/UPDATE/DELETE policyは作らない。
-- 書込みは security definer RPC のみ許可し、重複・1ヶ月制限・レート制限を必ず通す。

revoke all on public.action_rate_limits from anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.office_status from anon, authenticated;
revoke insert, update, delete on public.open_close_logs from anon, authenticated;
revoke insert, update, delete on public.reservations from anon, authenticated;

revoke execute on function public.is_master(uuid) from public, anon;
revoke execute on function public.consume_rate_limit(text,integer,integer) from public, anon;
revoke execute on function public.validate_reservation_window(date,time,time,uuid) from public, anon;
revoke execute on function public.set_office_state(boolean) from public, anon;
revoke execute on function public.create_reservation(date,time,time,text) from public, anon;
revoke execute on function public.update_reservation(uuid,date,time,time,text) from public, anon;
revoke execute on function public.delete_reservation(uuid) from public, anon;
revoke execute on function public.set_user_role(uuid,public.user_role) from public, anon;

grant select on public.profiles, public.office_status, public.open_close_logs, public.reservations to authenticated;
grant execute on function public.set_office_state(boolean) to authenticated;
grant execute on function public.create_reservation(date,time,time,text) to authenticated;
grant execute on function public.update_reservation(uuid,date,time,time,text) to authenticated;
grant execute on function public.delete_reservation(uuid) to authenticated;
grant execute on function public.set_user_role(uuid,public.user_role) to authenticated;

-- Realtime対象。すでに登録済みならNOTICEのみ。
do $$ begin
  alter publication supabase_realtime add table public.office_status;
exception when duplicate_object then raise notice 'office_status already in realtime publication';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.reservations;
exception when duplicate_object then raise notice 'reservations already in realtime publication';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.open_close_logs;
exception when duplicate_object then raise notice 'open_close_logs already in realtime publication';
end $$;

-- 初回だけ実行例：最初のマスター権限を付与
-- update public.profiles set role = 'master' where id = 'AUTH_USER_UUID';
