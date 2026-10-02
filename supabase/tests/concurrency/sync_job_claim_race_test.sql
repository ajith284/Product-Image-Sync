-- Sync job claim race (Prompt 14B) — LOCAL / TEST POSTGRES ONLY.
--
-- Uses real concurrent sessions (dblink), so the setup rows must be COMMITTED. The script
-- therefore refuses to run unless:
--   * it is started with   psql -v allow_committed_test_data=1 -f <this file>
--   * the server is local (unix socket, loopback or a private address) — never a hosted project.
-- Everything it creates is tagged and deleted at the end (also after a failing assertion).
-- Requires the dblink extension (created here if missing, dropped again if it was created here)
-- and password-less (trust / peer) access for the current role, as on a local test cluster.
\set ON_ERROR_STOP off
\if :{?allow_committed_test_data}
\else
  \echo 'REFUSED: run with -v allow_committed_test_data=1 against a LOCAL test database only.'
  \quit
\endif

do $guard$
begin
  if inet_server_addr() is not null
     and not (inet_server_addr() << '127.0.0.0/8'::inet or inet_server_addr() = '::1'::inet
              or inet_server_addr() << '10.0.0.0/8'::inet or inet_server_addr() << '172.16.0.0/12'::inet
              or inet_server_addr() << '192.168.0.0/16'::inet) then
    raise exception 'REFUSED: % is not a local server', inet_server_addr();
  end if;
end
$guard$;
\if :ERROR
  \echo 'REFUSED: not a local server.'
  \quit
\endif

select not exists (select 1 from pg_extension where extname = 'dblink') as created_dblink \gset
create extension if not exists dblink;

-- ---------------------------------------------------------------- setup (committed)
create temp table race_ctx as
select gen_random_uuid() as owner_id, gen_random_uuid() as job_lock, gen_random_uuid() as job_burst,
       gen_random_uuid() as job_stale, gen_random_uuid() as job_n8n,
       format('host=%s port=%s dbname=%s user=%s',
              coalesce(host(inet_server_addr()), split_part(current_setting('unix_socket_directories'), ',', 1)),
              current_setting('port'), current_database(), current_user) as dsn,
       null::uuid as ws, null::uuid as store, null::uuid as key_id;
create temp table race_results (ord serial, line text, passed boolean);

insert into auth.users (id, instance_id, aud, role, email)
select owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'race-' || owner_id || '@race.local'
from race_ctx;
update race_ctx set ws = (select workspace_id from public.workspace_members m where m.user_id = race_ctx.owner_id);
insert into public.stores (workspace_id, name, shopify_domain)
select ws, 'Race store', 'race-' || left(owner_id::text, 8) || '.myshopify.com' from race_ctx;
update race_ctx set store = (select id from public.stores s where s.workspace_id = race_ctx.ws);
-- One active job per store is enforced, so each scenario gets its job when it starts (see below).
-- (the test owner calls the service-only RPC directly; the worker sessions below use service_role)
update race_ctx set key_id = public.api_key_create(owner_id, ws, null, 'race key', array['n8n:read', 'n8n:sync', 'n8n:jobs'],
                                                   'pis_live_race' || left(replace(owner_id::text, '-', ''), 8), repeat('a', 64), null);

-- ---------------------------------------------------------------- scenarios
do $race$
declare
  c record; i int; n int; v text; rec record; winner text;
  conns text[] := array['race_w1', 'race_w2', 'race_w3', 'race_w4', 'race_w5', 'race_w6'];
  procedure_ok boolean;
begin
  select * into c from race_ctx;
  foreach v in array conns loop
    perform dblink_connect(v, c.dsn);
    perform dblink_exec(v, 'set role service_role');
  end loop;
  -- Separate autocommit session for job rows: the other sessions only see committed rows.
  perform dblink_connect('race_admin', c.dsn);

  -- ===== S1: worker 1 holds the row lock; worker 2 must wait, then get already_running =====
  perform dblink_exec('race_admin', format('insert into public.sync_jobs (id, store_id, workspace_id, status, trigger_type, dry_run) values (%L, %L, %L, ''queued'', ''api'', true)', c.job_lock, c.store, c.ws));
  perform dblink_exec('race_w1', 'begin');
  select t.claimed, t.reason into rec from dblink('race_w1',
    format('select claimed, reason from public.sync_job_claim(%L, %L, %L, 900)', c.ws, c.job_lock, 'worker-race-0001'))
    as t(claimed boolean, reason text);
  insert into race_results (line, passed) values ('S1 worker 1 claims inside an open transaction: ' || rec.reason, rec.claimed and rec.reason = 'claimed');
  perform dblink_send_query('race_w2',
    format('select claimed, reason from public.sync_job_claim(%L, %L, %L, 900)', c.ws, c.job_lock, 'worker-race-0002'));
  perform pg_sleep(0.5);
  insert into race_results (line, passed) values ('S1 worker 2 blocks on the row lock while worker 1''s claim is uncommitted', dblink_is_busy('race_w2') = 1);
  perform dblink_exec('race_w1', 'commit');
  select t.claimed, t.reason into rec from dblink_get_result('race_w2') as t(claimed boolean, reason text);
  perform * from dblink_get_result('race_w2') as t(claimed boolean, reason text);  -- drain
  insert into race_results (line, passed) values ('S1 worker 2 then gets claimed=false / ' || coalesce(rec.reason, 'null'), not rec.claimed and rec.reason = 'already_running');
  select worker_id into v from public.sync_jobs where id = c.job_lock;
  insert into race_results (line, passed) values ('S1 the live lease belongs to worker 1 only (' || coalesce(v, 'null') || ')', v = 'worker-race-0001');
  begin
    perform * from dblink('race_w2', format('select public.sync_job_heartbeat(%L, %L, %L, null)', c.ws, c.job_lock, 'worker-race-0002')) as t(j jsonb);
    insert into race_results (line, passed) values ('S1 worker 2 heartbeat was accepted', false);
  exception when others then
    insert into race_results (line, passed) values ('S1 worker 2 cannot heartbeat / report progress (job_not_owned)', sqlerrm like '%job_not_owned%');
  end;
  begin
    perform * from dblink('race_w2', format('select public.sync_item_record(%L, %L, %L, %L::jsonb)', c.ws, c.job_lock, 'worker-race-0002',
      '{"drive_folder_id":"prodRaceFolder1","status":"matched"}')) as t(id uuid);
    insert into race_results (line, passed) values ('S1 worker 2 wrote a sync_item', false);
  exception when others then
    insert into race_results (line, passed) values ('S1 worker 2 cannot write sync_items for the job', sqlerrm like '%job_not_owned%');
  end;
  begin
    perform * from dblink('race_w2', format('select public.sync_job_finish(%L, %L, %L, %L, null, null, %L::jsonb, %L::jsonb)',
      c.ws, c.job_lock, 'worker-race-0002', 'completed', '{}', '{}')) as t(j jsonb);
    insert into race_results (line, passed) values ('S1 worker 2 finished the job', false);
  exception when others then
    insert into race_results (line, passed) values ('S1 worker 2 cannot finish the job', sqlerrm like '%job_not_owned%');
  end;
  select (j->>'cancel_requested')::boolean is not null into procedure_ok
  from dblink('race_w1', format('select public.sync_job_heartbeat(%L, %L, %L, %L::jsonb)', c.ws, c.job_lock, 'worker-race-0001', '{"processed":1}')) as t(j jsonb);
  insert into race_results (line, passed) values ('S1 worker 1 keeps reporting progress', procedure_ok);
  perform * from dblink('race_w1', format('select public.sync_job_finish(%L, %L, %L, %L, null, null, %L::jsonb, %L::jsonb)',
    c.ws, c.job_lock, 'worker-race-0001', 'completed', '{"total":0}', '{}')) as t(j jsonb);
  select t.claimed, t.reason into rec from dblink('race_w2',
    format('select claimed, reason from public.sync_job_claim(%L, %L, %L, 900)', c.ws, c.job_lock, 'worker-race-0002')) as t(claimed boolean, reason text);
  insert into race_results (line, passed) values ('S1 after worker 1 finishes, worker 2''s claim → finished (no re-run)', not rec.claimed and rec.reason = 'finished');

  -- ===== S2: six workers claim a queued job at the same instant → exactly one wins =====
  perform dblink_exec('race_admin', format('insert into public.sync_jobs (id, store_id, workspace_id, status, trigger_type, dry_run) values (%L, %L, %L, ''queued'', ''api'', true)', c.job_burst, c.store, c.ws));
  create temp table burst (worker text, claimed boolean, reason text);
  for i in 1..6 loop
    perform dblink_send_query(conns[i], format('select %L::text, claimed, reason from public.sync_job_claim(%L, %L, %L, 900)',
      'worker-burst-000' || i, c.ws, c.job_burst, 'worker-burst-000' || i));
  end loop;
  for i in 1..6 loop
    insert into burst select * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
    perform * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
  end loop;
  select count(*) filter (where claimed), count(*) filter (where not claimed and reason = 'already_running'),
         max(worker) filter (where claimed) into n, i, winner from burst;
  insert into race_results (line, passed) values (format('S2 6 simultaneous claims → %s claimed, %s already_running', n, i), n = 1 and i = 5);
  select worker_id into v from public.sync_jobs where id = c.job_burst;
  insert into race_results (line, passed) values ('S2 the stored owner is the single winner (' || coalesce(v, 'null') || ')', v = winner);
  perform dblink_exec('race_admin', format('update public.sync_jobs set status = ''completed'', completed_at = now(), worker_id = null where id = %L', c.job_burst));
  drop table burst;

  -- ===== S3: stale lease (crashed worker) → six reclaimers race → exactly one reclaims =====
  perform dblink_exec('race_admin', format(
    'insert into public.sync_jobs (id, store_id, workspace_id, status, trigger_type, dry_run, worker_id, claimed_at, heartbeat_at, started_at) '
    'values (%L, %L, %L, ''running'', ''api'', true, ''worker-crashed-01'', now() - interval ''1 hour'', now() - interval ''30 minutes'', now() - interval ''1 hour'')',
    c.job_stale, c.store, c.ws));
  create temp table burst (worker text, claimed boolean, reason text);
  for i in 1..6 loop
    perform dblink_send_query(conns[i], format('select %L::text, claimed, reason from public.sync_job_claim(%L, %L, %L, 900)',
      'worker-reclm-000' || i, c.ws, c.job_stale, 'worker-reclm-000' || i));
  end loop;
  for i in 1..6 loop
    insert into burst select * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
    perform * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
  end loop;
  select count(*) filter (where claimed and reason = 'reclaimed'), count(*) filter (where not claimed and reason = 'already_running'),
         max(worker) filter (where claimed) into n, i, winner from burst;
  insert into race_results (line, passed) values (format('S3 stale lease, 6 simultaneous reclaims → %s reclaimed, %s already_running', n, i), n = 1 and i = 5);
  select worker_id into v from public.sync_jobs where id = c.job_stale;
  insert into race_results (line, passed) values ('S3 the crashed worker lost the job; the single reclaimer owns it', v = winner and v <> 'worker-crashed-01');
  begin
    perform * from dblink('race_w1', format('select public.sync_job_heartbeat(%L, %L, %L, null)', c.ws, c.job_stale, 'worker-crashed-01')) as t(j jsonb);
    insert into race_results (line, passed) values ('S3 the crashed worker could still heartbeat', false);
  exception when others then
    insert into race_results (line, passed) values ('S3 the crashed worker, if it wakes up, is rejected (job_not_owned)', sqlerrm like '%job_not_owned%');
  end;
  perform dblink_exec('race_admin', format('update public.sync_jobs set status = ''completed'', completed_at = now(), worker_id = null where id = %L', c.job_stale));
  drop table burst;

  -- ===== S4: the n8n /run path (n8n_start_sync_job) under the same race =====
  perform dblink_exec('race_admin', format('insert into public.sync_jobs (id, store_id, workspace_id, status, trigger_type, dry_run) values (%L, %L, %L, ''queued'', ''n8n'', true)', c.job_n8n, c.store, c.ws));
  create temp table burst (worker text, claimed boolean, reason text);
  for i in 1..6 loop
    perform dblink_send_query(conns[i], format('select %L::text, claimed, reason from public.n8n_start_sync_job(%L, %L, %L, %L)',
      'n8n-race-worker-' || i, c.key_id, c.job_n8n, 'req-race-' || i, 'n8n-race-worker-' || i));
  end loop;
  for i in 1..6 loop
    insert into burst select * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
    perform * from dblink_get_result(conns[i]) as t(worker text, claimed boolean, reason text);
  end loop;
  select count(*) filter (where claimed), count(*) filter (where not claimed and reason = 'already_running'),
         max(worker) filter (where claimed) into n, i, winner from burst;
  insert into race_results (line, passed) values (format('S4 6 simultaneous POST /run → %s claimed, %s already_running', n, i), n = 1 and i = 5);
  select count(*) into n from public.activity_logs where event_type = 'sync_job_started' and (metadata->>'job_id')::uuid = c.job_n8n;
  insert into race_results (line, passed) values (format('S4 exactly one sync_job_started activity entry (%s)', n), n = 1);
  select worker_id into v from public.sync_jobs where id = c.job_n8n;
  insert into race_results (line, passed) values ('S4 the stored owner is the single winner', v = winner);
  perform dblink_exec('race_admin', format('update public.sync_jobs set status = ''completed'', completed_at = now(), worker_id = null where id = %L', c.job_n8n));
  drop table burst;

  foreach v in array conns || array['race_admin'] loop perform dblink_disconnect(v); end loop;
exception when others then
  insert into race_results (line, passed) values ('scenario aborted: ' || sqlerrm, false);
  foreach v in array conns || array['race_admin'] loop
    begin perform dblink_disconnect(v); exception when others then null; end;
  end loop;
end
$race$;

-- ---------------------------------------------------------------- cleanup (always runs)
delete from public.activity_logs where workspace_id = (select ws from race_ctx);
delete from public.sync_jobs where workspace_id = (select ws from race_ctx);
delete from internal.api_keys where workspace_id = (select ws from race_ctx);
delete from public.stores where workspace_id = (select ws from race_ctx);
delete from public.workspaces where id = (select ws from race_ctx);
delete from auth.users where id = (select owner_id from race_ctx);
\if :created_dblink
drop extension if exists dblink;
\endif

do $report$
declare r text := E'\n'; ok int; bad int; left_over int;
begin
  select coalesce(string_agg(case when passed then 'PASS ' else 'FAIL ' end || line, E'\n' order by ord), '') into r from race_results;
  select count(*) filter (where passed), count(*) filter (where not passed) into ok, bad from race_results;
  select (select count(*) from public.workspaces where id = (select ws from race_ctx))
       + (select count(*) from auth.users where id = (select owner_id from race_ctx)) into left_over;
  if left_over = 0 then ok := ok + 1; r := r || E'\nPASS committed test data cleaned up';
  else bad := bad + 1; r := r || E'\nFAIL test data left behind: ' || left_over; end if;
  raise exception '%', E'\n' || r || E'\n\nsync job claim race tests: ' || ok || ' passed, ' || bad || ' failed';
end
$report$;
