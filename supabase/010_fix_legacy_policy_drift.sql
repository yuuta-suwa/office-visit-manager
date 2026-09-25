-- Production had drifted from 002_office_community_v2.sql: is_master() and
-- three "select_authenticated" (USING (true)) policies from schema.sql were
-- still live, as if 002's replacements for them had never taken effect,
-- even though the rest of 002 (and 003-009) was correctly applied. The
-- likely cause is a partial/manual application of 002 that skipped these
-- specific statements; the exact history is unconfirmed.
--
-- Effects of the drift, found 2026-09-24/25:
-- 1. is_master() still checked role = 'master' (schema.sql's pre-002
--    definition). No profile has had role='master' since 002 migrated
--    master->admin, so set_office_state() (open/close) rejected every
--    user, including admin -- this is what blocked opening the office.
-- 2. profiles_select_authenticated (USING (true)) let every authenticated
--    user read every profile row. Found and dropped ad hoc on 2026-09-24
--    (not captured in a migration file until now); restated here so a
--    fresh environment doesn't need that manual step.
-- 3. reservations_select_authenticated (USING (true)) let every
--    authenticated user read every other member's reservations (visit
--    times, notes) -- the same class of leak as #2, on the reservations
--    table.
-- 4. office_status_select_authenticated / logs_select_authenticated
--    (USING (true)) let every authenticated user, including inactive
--    ones, read office open/close state and who opened/closed it,
--    instead of being limited to active members / key_manager+admin.
--
-- is_master() is restored to 002's definition (role in key_manager/admin,
-- the same merged tier 009 formalized elsewhere), so "admin counts as
-- key_manager" for office open/close. is_key_manager_or_admin() itself
-- isn't reused here because it always reads auth.uid() internally and
-- can't be pointed at an arbitrary p_user_id.
create or replace function public.is_master(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = p_user_id and active = true and role in ('key_manager', 'admin')
  );
$$;

drop policy if exists "profiles_select_authenticated" on public.profiles;
drop policy if exists "reservations_select_authenticated" on public.reservations;
drop policy if exists "office_status_select_authenticated" on public.office_status;
drop policy if exists "logs_select_authenticated" on public.open_close_logs;

-- 002's replacement policies for these three tables were, it turns out,
-- ALSO never created in production (found only after the drops above ran:
-- dropping the old permissive policy left these three tables with zero
-- SELECT policies at all, which made RLS deny every read -- an outage this
-- script introduces and must fix in the same breath). profiles' own
-- replacement (profiles_select_self_or_manager) already exists from 009.
create policy "reservations_select_by_role" on public.reservations for select to authenticated
  using (user_id = auth.uid() or public.is_key_manager_or_admin());
create policy "office_status_active_member" on public.office_status for select to authenticated
  using (public.is_active_member());
create policy "logs_key_manager_or_admin" on public.open_close_logs for select to authenticated
  using (public.is_key_manager_or_admin());
