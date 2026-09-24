-- Merges admin and key_manager into one effective permission tier (event
-- management, LINE notify, and the member list all become available to
-- both), while keeping the single-admin invariant intact: only an existing
-- admin may grant admin, demote an admin, or otherwise touch an admin
-- account. This lets a key_manager freely switch other members between
-- 'member' and 'key_manager', which is the new capability requested.
-- Requires schema.sql + 002_office_community_v2.sql (is_admin,
-- is_key_manager_or_admin, set_user_role, profiles_select_self_or_admin)
-- and 005_venue_participation.sql (create_event_with_members).

-- Event creation/management (previously admin-only) is now available to
-- key_manager too. Signature is unchanged, so CREATE OR REPLACE is safe.
create or replace function public.create_event_with_members(
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
  if not public.is_key_manager_or_admin() then raise exception 'Key manager or admin role required'; end if;
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

-- The member list (for event participant selection and the "member
-- management" screen) is now visible to key_manager as well, not just admin.
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_manager" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_key_manager_or_admin());

-- set_user_role: a key_manager may now call this too, but only to move
-- someone between 'member' and 'key_manager'. Granting/revoking admin, and
-- changing an existing admin's role at all, stays admin-only so a
-- key_manager can never escalate themselves or anyone else to admin, and
-- can never touch the single production admin account.
create or replace function public.set_user_role(p_user_id uuid, p_role public.user_role)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_current public.user_role;
  v_admin_count integer;
  v_caller_is_admin boolean := public.is_admin();
begin
  if not public.is_key_manager_or_admin() then
    raise exception 'Key manager or admin role required';
  end if;

  select role into v_current from public.profiles where id = p_user_id for update;
  if not found then raise exception 'User not found'; end if;

  if not v_caller_is_admin then
    if p_role = 'admin' then raise exception 'Admin role required to grant admin'; end if;
    if v_current = 'admin' then raise exception 'Admin role required to change an admin account'; end if;
  end if;

  if v_current = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count from public.profiles where role = 'admin' and active = true;
    if v_admin_count <= 1 then raise exception 'At least one active admin is required'; end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;
end;
$$;
