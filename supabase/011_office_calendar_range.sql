-- Adds a month/range view of the existing "office calendar" concept
-- (office_calendar_summary from 002 only covers a single date, used by
-- TodayVisitors). Same privacy model: aggregate counts per day only, never
-- names, notes, or individual reservation times -- any authenticated member
-- can see how many people are planning to come in on a given day, not who.
-- Requires schema.sql + 002_office_community_v2.sql (reservations,
-- unlock_schedules).
create or replace function public.office_calendar_range_summary(p_start date, p_end date)
returns table (visit_date date, planned_count bigint, has_unlock boolean)
language sql
stable
security definer set search_path = public
as $$
  select r.visit_date, count(*)::bigint,
    exists(select 1 from public.unlock_schedules u where u.date = r.visit_date)
  from public.reservations r
  where r.visit_date between p_start and p_end and r.status = 'active'
  group by r.visit_date
  order by r.visit_date
$$;

revoke execute on function public.office_calendar_range_summary(date, date) from public, anon;
grant execute on function public.office_calendar_range_summary(date, date) to authenticated;
