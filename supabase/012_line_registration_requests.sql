-- Staff registration requests sent from LINE ("登録 氏名 メールアドレス").
-- The LINE webhook (service role) records a pending request; an admin or
-- key manager approves it in the app, which sends the normal Supabase
-- invite email and links profiles.line_user_id. Only managers can read
-- requests (they contain an email address); all writes go through the
-- service role, so no INSERT/UPDATE policy exists for app users.
-- Requires 002_office_community_v2.sql (profiles.line_user_id,
-- is_key_manager_or_admin).
create table if not exists public.line_registration_requests (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  full_name text not null,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz
);

alter table public.line_registration_requests enable row level security;

create policy "line_registration_requests_manager_select" on public.line_registration_requests
  for select to authenticated using (public.is_key_manager_or_admin());

revoke all on public.line_registration_requests from public, anon, authenticated;
grant select on public.line_registration_requests to authenticated;

-- service_role is a Supabase role; it does not exist in a plain Postgres
-- (e.g. the local test fixture), so only grant when present.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.line_registration_requests to service_role;
  end if;
end $$;
