-- Read-only. Run in Supabase SQL Editor before approving 004/005/006/007/008/009. No personal rows queried.
select p.oid::regprocedure::text as signature, pg_get_function_result(p.oid) as result,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
 'current_role','is_admin','is_key_manager_or_admin','handle_new_user','set_user_role',
 'event_attendance_admin','confirm_event_attendance','create_event_with_members','respond_to_event',
 'validate_reservation_window','create_reservation','update_reservation','delete_reservation','cancel_reservation',
 'record_event_response_via_service','event_notification_targets','event_report_recipients','log_notification'
) order by p.proname;
select tablename, policyname, roles, cmd, qual, with_check from pg_policies
where schemaname='public' and tablename in ('profiles','reservations','events','event_members','event_responses','reservation_audit_logs','notification_logs','event_notification_members','report_recipients');
select table_name, column_name, data_type from information_schema.columns
where table_schema='public' and table_name in ('profiles','event_responses','events','reservations','reservation_audit_logs','notification_logs')
order by table_name, ordinal_position;

-- Confirms whether 'venue' already exists on event_participation_type before 005 is applied.
select enumlabel from pg_enum e
join pg_type t on t.oid = e.enumtypid
where t.typname = 'event_participation_type'
order by e.enumsortorder;

-- RLS policies alone do not prove that RLS is enabled or that RPC execution is restricted.
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('profiles','reservations','events','event_members','event_responses','reservation_audit_logs','notification_logs');
select p.oid::regprocedure::text as signature, p.prosecdef as security_definer,
       p.proconfig as function_settings,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('is_admin','is_key_manager_or_admin','set_user_role',
 'event_attendance_admin','confirm_event_attendance','create_event_with_members','respond_to_event',
 'update_reservation','delete_reservation','cancel_reservation',
 'record_event_response_via_service','event_notification_targets','event_report_recipients','log_notification');
