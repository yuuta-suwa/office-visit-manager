-- reservation_audit_logs has existed since 002 with an admin-only SELECT
-- policy, but 002 never granted table-level SELECT to authenticated, so
-- nobody could actually read it through the API even after 006 started
-- writing rows to it on every cancel/edit. This also extends visibility to
-- key_manager: key_manager already sees every reservation in full
-- (reservations_select_by_role), so seeing its change history is consistent
-- with an existing boundary, not a new one.
drop policy if exists "audit_admin_only" on public.reservation_audit_logs;
create policy "audit_key_manager_or_admin" on public.reservation_audit_logs
  for select to authenticated using (public.is_key_manager_or_admin());

grant select on public.reservation_audit_logs to authenticated;
