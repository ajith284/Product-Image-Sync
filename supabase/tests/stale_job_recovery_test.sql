-- Stale-job recovery contract (Prompt 14E) — the exact path the production n8n workflow takes.
-- One DO block ending with RAISE EXCEPTION, so everything is rolled back.
--   worker dies → job stays 'running' → create returns sync_job_already_active + the job id
--   → POST /run (n8n_start_sync_job) on that id: live lease → already_running,
--     stale lease → reclaimed (old worker locked out), finished → finished. Never a 2nd job.
do $test$
declare
  a uuid := gen_random_uuid(); ws uuid; s uuid; k uuid; job uuid; active text; rec record; n int;
  h text := repeat('1', 64);
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', a::text || '@stale.local');
  select workspace_id into ws from public.workspace_members where user_id = a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws, 'Stale', 'stale-' || left(a::text, 8) || '.myshopify.com') returning id into s;
  insert into public.shopify_connections (store_id, shop_domain, connection_status)
    select s, shopify_domain, 'connected' from public.stores where id = s;
  insert into public.google_drive_connections (store_id, connection_status, root_folder_id, root_folder_name) values (s, 'connected', 'sofaFolderId001', 'Sofa');
  perform set_config('role', 'service_role', true);
  k := public.api_key_create(a, ws, null, 'n8n', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_stal' || left(replace(a::text, '-', ''), 8), h, null);

  -- run 1: job created and claimed by a worker that then dies
  select (x.job->>'job_id')::uuid into job from public.n8n_create_sync_job(k, s, 'scheduled', false, '{}'::jsonb, 'stale-idem-1', h, 'req-stale-1') x;
  perform public.n8n_start_sync_job(k, job, 'req-stale-run-1', 'n8n-dead-worker-1');

  -- run 2 (lease still alive): create refuses with the active id; /run → already_running
  begin
    perform public.n8n_create_sync_job(k, s, 'scheduled', false, '{}'::jsonb, 'stale-idem-2', h, 'req-stale-2');
    bad := bad + 1; r := r || 'FAIL a second job was created while one is active' || E'\n';
  exception when others then
    get stacked diagnostics active = pg_exception_detail;
    if sqlerrm = 'sync_job_already_active' and active = job::text then
      ok := ok + 1; r := r || 'PASS create while active → sync_job_already_active with the active job id' || E'\n';
    else bad := bad + 1; r := r || 'FAIL create: ' || sqlerrm || ' / ' || coalesce(active, 'null') || E'\n'; end if;
  end;
  select * into rec from public.n8n_start_sync_job(k, active::uuid, 'req-stale-run-2', 'n8n-new-worker-02');
  if not rec.claimed and rec.reason = 'already_running' then
    ok := ok + 1; r := r || 'PASS /run on the active id while its lease is alive → already_running (workflow just waits)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL live lease: ' || rec.reason || E'\n'; end if;

  -- the dead worker's lease expires
  update public.sync_jobs set heartbeat_at = now() - interval '16 minutes' where id = job;

  -- run 3: create still refuses (no duplicate job); /run on the active id reclaims it
  begin
    perform public.n8n_create_sync_job(k, s, 'scheduled', false, '{}'::jsonb, 'stale-idem-3', h, 'req-stale-3');
    bad := bad + 1; r := r || 'FAIL a duplicate recovery job was created' || E'\n';
  exception when others then
    get stacked diagnostics active = pg_exception_detail;
    if sqlerrm = 'sync_job_already_active' and active = job::text then
      ok := ok + 1; r := r || 'PASS stale job still blocks a NEW job (no duplicate recovery job)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL stale create: ' || sqlerrm || E'\n'; end if;
  end;
  select * into rec from public.n8n_start_sync_job(k, active::uuid, 'req-stale-run-3', 'n8n-new-worker-03');
  if rec.claimed and rec.reason = 'reclaimed' then
    ok := ok + 1; r := r || 'PASS /run on the stale job → reclaimed by the new worker' || E'\n';
  else bad := bad + 1; r := r || 'FAIL reclaim: ' || rec.reason || E'\n'; end if;
  begin
    perform public.sync_job_heartbeat(ws, job, 'n8n-dead-worker-1', null);
    bad := bad + 1; r := r || 'FAIL the dead worker could still write' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_owned' then ok := ok + 1; r := r || 'PASS the old worker is locked out (job_not_owned)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL old worker: ' || sqlerrm || E'\n'; end if;
  end;
  select count(*) into n from public.sync_jobs where store_id = s;
  if n = 1 then ok := ok + 1; r := r || 'PASS still exactly one job for the store' || E'\n';
  else bad := bad + 1; r := r || 'FAIL jobs: ' || n || E'\n'; end if;

  -- the new worker finishes; a later /run on the same id does nothing; a new job can now be created
  perform public.sync_job_finish(ws, job, 'n8n-new-worker-03', 'completed', null, null, '{}'::jsonb, '{}'::jsonb);
  select * into rec from public.n8n_start_sync_job(k, job, 'req-stale-run-4', 'n8n-new-worker-04');
  if not rec.claimed and rec.reason = 'finished' then
    ok := ok + 1; r := r || 'PASS /run after completion → finished (no re-processing)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL finished: ' || rec.reason || E'\n'; end if;
  perform public.n8n_create_sync_job(k, s, 'scheduled', false, '{}'::jsonb, 'stale-idem-5', h, 'req-stale-5');
  ok := ok + 1; r := r || 'PASS after the recovered job finished, the next scheduled run can create a new job' || E'\n';

  raise exception '%', r || E'\nstale job recovery tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
