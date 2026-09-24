const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url).pathname;
const db=new PGlite();
const sql=p=>readFileSync(root+'/supabase/'+p,'utf8');
await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}'); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to public; grant execute on function auth.uid() to public;`);
let base=sql('schema.sql').replace('create extension if not exists pgcrypto;','').replace(/do \$\$ begin\s*alter publication[\s\S]*?end \$\$;/gi,'');
await db.exec(base);
let v2=sql('002_office_community_v2.sql');const enums=v2.match(/^alter type public.user_role.*;$/gm);for(const e of enums)await db.exec(e);v2=v2.replace(/^alter type public.user_role.*;$/gm,'');await db.exec(v2);
// Model SELECT grants reported in the user's production handoff; not part of old 002.
await db.exec('grant select on events,event_members,event_responses to authenticated');
await db.exec(sql('003_event_actions.sql'));await db.exec(sql('004_attendance_hardening.sql'));
let v3=sql('005_venue_participation.sql');const enums3=v3.match(/^alter type public\.event_participation_type.*;$/gm);for(const e of enums3)await db.exec(e);v3=v3.replace(/^alter type public\.event_participation_type.*;$/gm,'');await db.exec(v3);
await db.exec(sql('006_reservation_cancel_edit.sql'));
await db.exec(sql('007_reservation_audit_visibility.sql'));
await db.exec(sql('008_line_integration.sql'));
await db.exec(sql('009_merge_admin_key_manager.sql'));
const ids=Array.from({length:7},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
for (let i=0;i<6;i++)await db.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{"role":"admin"}')`,[ids[i],`CODEX_TEST_${i}@example.invalid`]);
assert.equal((await db.query('select role from profiles where id=$1',[ids[0]])).rows[0].role,'member');
await db.query(`update profiles set role=case when id=$1 then 'admin'::user_role when id=$2 then 'key_manager'::user_role else 'member'::user_role end`,[ids[2],ids[3]]);await db.query('update profiles set active=false where id=$1',[ids[4]]);
const event=(await db.query(`insert into events(title,starts_at,ends_at,created_by,zoom_allowed) values('CODEX_TEST_TODAY',now()-interval '1 hour',now()+interval '1 hour',$1,true) returning id`,[ids[2]])).rows[0].id;
for(const id of [ids[0],ids[1],ids[5]])await db.query('insert into event_members(event_id,member_id) values($1,$2)',[event,id]);
await db.query(`insert into event_responses(event_id,member_id,participation_type,planned_arrival) values($1,$2,'office','10:00'),($1,$3,'absent',null)`,[event,ids[0],ids[1]]);
await db.query(`insert into reservations(user_id,visit_date,start_time,end_time,note) values($1,current_date,'10:00','11:00','CODEX_TEST_A'),($2,current_date,'10:00','11:00','CODEX_TEST_B')`,[ids[0],ids[1]]);
async function as(id,fn){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec('set role authenticated');try{return await fn();}finally{await db.exec('reset role');}}
let passed=1;
async function rejects(id,statement,params=[]){await as(id,()=>assert.rejects(db.query(statement,params)));passed++;}
for(const id of [ids[0],ids[4],ids[6],null]){
 await rejects(id,'select * from event_attendance_admin($1)',[event]);
 await rejects(id,'select confirm_event_attendance($1,$2,true)',[event,ids[0]]);
 await rejects(id,`select create_event_with_members('CODEX_TEST_DENIED','other',now(),now()+interval '1 hour',false,true,'')`);
}
// 009_merge_admin_key_manager.sql: key_manager is now merged with admin for
// event management, so this now succeeds instead of being rejected.
await as(ids[3],async()=>{const r=(await db.query(`select create_event_with_members('CODEX_TEST_KEYMGR_CREATE','other',now(),now()+interval '1 hour',false,true,'') as id`)).rows[0];assert.ok(r.id);passed++;});
await as(ids[0],async()=>{for(const [table,column] of [['reservations','user_id'],['event_members','member_id'],['event_responses','member_id']]){const rows=(await db.query(`select ${column} from ${table}`)).rows;assert.ok(rows.length);assert.ok(rows.every(r=>r[column]===ids[0]));passed++;}});
for(const id of [ids[2],ids[3]])await as(id,async()=>{const roster=(await db.query('select * from event_attendance_admin($1)',[event])).rows;assert.equal(roster.length,3);assert.equal(roster.filter(r=>r.participation_type===null).length,1);passed++;await db.query('select confirm_event_attendance($1,$2,true)',[event,ids[0]]);const row=(await db.query('select * from event_responses where event_id=$1 and member_id=$2',[event,ids[0]])).rows[0];assert.equal(row.confirmed_by,id);assert.equal(row.attendance_confirmed,true);assert.equal(row.planned_arrival,'10:00:00');assert.ok(row.actual_joined_at);passed++;await db.query('select confirm_event_attendance($1,$2,false)',[event,ids[0]]);const undone=(await db.query('select * from event_responses where event_id=$1 and member_id=$2',[event,ids[0]])).rows[0];assert.equal(undone.attendance_confirmed,false);assert.equal(undone.confirmed_by,null);assert.equal(undone.actual_joined_at,null);passed++;});
await rejects(ids[2],'select confirm_event_attendance($1,$2,true)',[event,ids[1]]);
await rejects(ids[2],'select confirm_event_attendance($1,$2,true)',[event,ids[5]]);
await rejects(ids[2],'select confirm_event_attendance($1,$2,null)',[event,ids[0]]);
await as(ids[0],async()=>{await db.query("select respond_to_event($1,'zoom',null,null)",[event]);const r=(await db.query('select participation_type from event_responses where event_id=$1 and member_id=$2',[event,ids[0]])).rows[0];assert.equal(r.participation_type,'zoom');passed++;});
const otherReservation=(await db.query('select id from reservations where user_id=$1',[ids[1]])).rows[0].id;
await rejects(ids[0],'select delete_reservation($1)',[otherReservation]);
await rejects(ids[0],"select update_reservation($1,current_date,'11:00','12:00','CODEX_TEST_DENIED','not my reservation')",[otherReservation]);
await as(ids[0],async()=>{const r=(await db.query("select create_reservation((now() at time zone 'Asia/Tokyo')::date,'14:00','15:00','CODEX_TEST_SAVE') as id")).rows[0];assert.ok(r.id);assert.equal((await db.query('select note from reservations where id=$1',[r.id])).rows[0].note,'CODEX_TEST_SAVE');passed++;});
await as(ids[3],async()=>{await db.query('select set_office_state(true)');passed++;});
await as(ids[2],async()=>{const r=(await db.query("select create_event_with_members('CODEX_TEST_CREATE','other',now(),now()+interval '1 hour',false,true,'',array[$1::uuid]) as id",[ids[0]])).rows[0];assert.ok(r.id);assert.equal((await db.query('select count(*)::int as n from event_members where event_id=$1',[r.id])).rows[0].n,1);passed++;});
await db.query("update events set starts_at=now()+interval '2 days',ends_at=now()+interval '3 days' where id=$1",[event]);await rejects(ids[2],'select confirm_event_attendance($1,$2,true)',[event,ids[0]]);
await db.exec('set role anon');await assert.rejects(db.query('select * from event_attendance_admin($1)',[event]));await db.exec('reset role');passed++;
// Venue participation (005_venue_participation.sql)
const venueEvent=(await db.query(`insert into events(title,starts_at,ends_at,created_by,office_required,venue_allowed,venue_name) values('CODEX_TEST_VENUE',now()-interval '1 hour',now()+interval '1 hour',$1,false,true,'CODEX_TEST_HALL') returning id`,[ids[2]])).rows[0].id;
await db.query('insert into event_members(event_id,member_id) values($1,$2),($1,$3)',[venueEvent,ids[0],ids[1]]);
await as(ids[0],async()=>{await db.query("select respond_to_event($1,'venue',null,null)",[venueEvent]);const r=(await db.query('select participation_type from event_responses where event_id=$1 and member_id=$2',[venueEvent,ids[0]])).rows[0];assert.equal(r.participation_type,'venue');passed++;});
await rejects(ids[1],"select respond_to_event($1,'venue',null,null)",[event]);
const officeRequiredEvent=(await db.query(`insert into events(title,starts_at,ends_at,created_by,office_required,zoom_allowed,venue_allowed) values('CODEX_TEST_OFFICE_REQUIRED',now()-interval '1 hour',now()+interval '1 hour',$1,true,true,true) returning id`,[ids[2]])).rows[0].id;
await db.query('insert into event_members(event_id,member_id) values($1,$2)',[officeRequiredEvent,ids[0]]);
await rejects(ids[0],"select respond_to_event($1,'venue',null,null)",[officeRequiredEvent]);
await rejects(ids[0],"select respond_to_event($1,'zoom',null,null)",[officeRequiredEvent]);
await as(ids[2],async()=>{await db.query('select confirm_event_attendance($1,$2,true)',[venueEvent,ids[0]]);const row=(await db.query('select * from event_responses where event_id=$1 and member_id=$2',[venueEvent,ids[0]])).rows[0];assert.equal(row.attendance_confirmed,true);assert.equal(row.participation_type,'venue');passed++;});
await rejects(ids[0],"select respond_to_event($1,'absent',null,null)",[venueEvent]);
await as(ids[2],async()=>{await db.query('select confirm_event_attendance($1,$2,false)',[venueEvent,ids[0]]);passed++;});
await as(ids[0],async()=>{await db.query("select respond_to_event($1,'absent',null,null)",[venueEvent]);const r=(await db.query('select participation_type from event_responses where event_id=$1 and member_id=$2',[venueEvent,ids[0]])).rows[0];assert.equal(r.participation_type,'absent');passed++;});
await as(ids[2],async()=>{const roster=(await db.query('select * from event_attendance_admin($1)',[venueEvent])).rows;assert.equal(roster.length,2);passed++;});
// Reservation cancel/edit with required reason (006_reservation_cancel_edit.sql)
let savedReservationId;
await as(ids[0],async()=>{const r=(await db.query("select create_reservation((now() at time zone 'Asia/Tokyo')::date,'16:00','17:00','CODEX_TEST_CANCEL') as id")).rows[0];savedReservationId=r.id;passed++;});
await rejects(ids[0],"select cancel_reservation($1,'')",[savedReservationId]);
await rejects(ids[0],"select update_reservation($1,(now() at time zone 'Asia/Tokyo')::date,'16:00','17:00','CODEX_TEST_CANCEL','')",[savedReservationId]);
await rejects(ids[1],"select cancel_reservation($1,'not mine')",[savedReservationId]);
await as(ids[0],()=>db.query("select update_reservation($1,(now() at time zone 'Asia/Tokyo')::date,'16:00','17:30','CODEX_TEST_CANCEL_UPDATED','CODEX_TEST_REASON_EDIT')",[savedReservationId]));
{
  const row=(await db.query('select end_time,note from reservations where id=$1',[savedReservationId])).rows[0];
  assert.equal(row.end_time,'17:30:00');assert.equal(row.note,'CODEX_TEST_CANCEL_UPDATED');
  const auditEdit=(await db.query('select reason from reservation_audit_logs where reservation_id=$1 order by changed_at desc limit 1',[savedReservationId])).rows[0];
  assert.equal(auditEdit.reason,'CODEX_TEST_REASON_EDIT');passed++;
}
await as(ids[0],()=>db.query("select cancel_reservation($1,'CODEX_TEST_REASON_CANCEL')",[savedReservationId]));
{
  const row=(await db.query('select status from reservations where id=$1',[savedReservationId])).rows[0];
  assert.equal(row.status,'cancelled');
  const auditCancel=(await db.query('select reason from reservation_audit_logs where reservation_id=$1 order by changed_at desc limit 1',[savedReservationId])).rows[0];
  assert.equal(auditCancel.reason,'CODEX_TEST_REASON_CANCEL');passed++;
}
// A cancelled reservation must not block a new one at the same time.
await as(ids[0],async()=>{const r=(await db.query("select create_reservation((now() at time zone 'Asia/Tokyo')::date,'16:00','17:00','CODEX_TEST_REBOOKED') as id")).rows[0];assert.ok(r.id);passed++;});
// delete_reservation is retired: EXECUTE is revoked even for the owner.
await rejects(ids[0],'select delete_reservation($1)',[savedReservationId]);
// Reservation audit-log visibility (007_reservation_audit_visibility.sql)
await as(ids[0],async()=>{const rows=(await db.query('select * from reservation_audit_logs')).rows;assert.equal(rows.length,0);passed++;});
for(const id of [ids[2],ids[3]])await as(id,async()=>{const rows=(await db.query('select * from reservation_audit_logs where reservation_id=$1',[savedReservationId])).rows;assert.equal(rows.length,2);passed++;});
await db.exec('set role anon');await assert.rejects(db.query('select * from reservation_audit_logs'));await db.exec('reset role');passed++;
// LINE integration RPCs (008_line_integration.sql)
await rejects(ids[0],"select record_event_response_via_service($1,$2,'office',null,null)",[ids[0],event]);
// No role set = the default (superuser-equivalent) connection, standing in for the service role.
await db.query("select record_event_response_via_service($1,$2,'office',null,null)",[ids[5],event]);
{
  const row=(await db.query('select participation_type,planned_arrival from event_responses where event_id=$1 and member_id=$2',[event,ids[5]])).rows[0];
  assert.equal(row.participation_type,'office');assert.ok(row.planned_arrival);passed++;
}
await assert.rejects(db.query("select record_event_response_via_service($1,$2,'zoom',null,null)",[ids[0],officeRequiredEvent]));passed++;
await db.query("select record_event_response_via_service($1,$2,'venue',null,null)",[ids[1],venueEvent]);
{
  const row=(await db.query('select participation_type from event_responses where event_id=$1 and member_id=$2',[venueEvent,ids[1]])).rows[0];
  assert.equal(row.participation_type,'venue');passed++;
}
await rejects(ids[0],'select event_notification_targets($1)',[event]);
await rejects(ids[0],'select event_report_recipients($1)',[event]);
await rejects(ids[0],"select log_notification($1,$2,'line_push','U123','sent',null)",[event,ids[0]]);
await db.query("update profiles set line_user_id='CODEX_TEST_LINE_1' where id=$1",[ids[0]]);
await db.query('insert into event_notification_members(event_id,member_id,enabled) values($1,$2,true)',[event,ids[0]]);
for(const id of [ids[2],ids[3]])await as(id,async()=>{
  const targets=(await db.query('select * from event_notification_targets($1)',[event])).rows;
  assert.ok(targets.some((t)=>t.member_id===ids[0]&&t.line_user_id==='CODEX_TEST_LINE_1'));passed++;
  await db.query("select log_notification($1,$2,'line_push',$3,'sent',null)",[event,ids[0],'CODEX_TEST_LINE_1']);passed++;
});
{
  const logs=(await db.query('select * from notification_logs where event_id=$1 and member_id=$2',[event,ids[0]])).rows;
  assert.equal(logs.length,2);assert.ok(logs.every((l)=>l.sent_at));passed++;
}
// Merged admin/key_manager permissions (009_merge_admin_key_manager.sql)
await rejects(ids[0],"select set_user_role($1,'key_manager')",[ids[1]]);
await as(ids[3],async()=>{await db.query("select set_user_role($1,'key_manager')",[ids[1]]);assert.equal((await db.query('select role from profiles where id=$1',[ids[1]])).rows[0].role,'key_manager');passed++;await db.query("select set_user_role($1,'member')",[ids[1]]);assert.equal((await db.query('select role from profiles where id=$1',[ids[1]])).rows[0].role,'member');passed++;});
await rejects(ids[3],"select set_user_role($1,'admin')",[ids[1]]);
await rejects(ids[3],"select set_user_role($1,'member')",[ids[2]]);
await as(ids[2],async()=>{await db.query("select set_user_role($1,'key_manager')",[ids[5]]);assert.equal((await db.query('select role from profiles where id=$1',[ids[5]])).rows[0].role,'key_manager');passed++;await db.query("select set_user_role($1,'member')",[ids[5]]);passed++;});
await as(ids[3],async()=>{const rows=(await db.query('select id from profiles')).rows;assert.ok(rows.length>=6);passed++;});
await as(ids[0],async()=>{const rows=(await db.query('select id from profiles')).rows;assert.equal(rows.length,1);assert.equal(rows[0].id,ids[0]);passed++;});

console.log(`${passed} PostgreSQL/RLS/RPC assertions passed (local PGlite, synthetic data only).`);await db.close();
