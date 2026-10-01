-- Sync worker tests (Prompt 13). One DO block ending with RAISE EXCEPTION, so everything
-- is rolled back. Run after 20261001220000_sync_worker.sql.
do $test$
declare
  a uuid := gen_random_uuid();   -- owner, workspace A
  b uuid := gen_random_uuid();   -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_a2 uuid; s_b uuid;
  k_a uuid; k_store2 uuid; k_read uuid; k_b uuid;
  h text := repeat('1', 64);
  job uuid; job2 uuid; it uuid; it2 uuid; j jsonb; rec record; n int; flag boolean; v text;
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.local'
  from unnest(array[a, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'BrandSure', 'w-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Second', 'w-a2.myshopify.com') returning id into s_a2;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'Other', 'w-b.myshopify.com') returning id into s_b;
  insert into public.shopify_connections (store_id, shop_domain, connection_status) values (s_a, 'w-a.myshopify.com', 'connected');
  insert into public.google_drive_connections (store_id, connection_status, root_folder_id, root_folder_name) values (s_a, 'connected', 'sofaFolderId001', 'Sofa');

  -- ---------- grants ----------
  select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                  and has_function_privilege('service_role', p.oid, 'execute'))
    into flag
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname in ('n8n_start_sync_job', 'sync_job_claim', 'sync_job_heartbeat', 'sync_job_finish', 'sync_item_record', 'sync_item_update');
  if flag then ok := ok + 1; r := r || 'PASS worker functions: service_role only' || E'\n';
  else bad := bad + 1; r := r || 'FAIL worker functions executable by users' || E'\n'; end if;

  perform set_config('role', 'service_role', true);
  k_a      := public.api_key_create(a, ws_a, null, 'n8n', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_wkra00000001', h, null);
  k_store2 := public.api_key_create(a, ws_a, s_a2, 'second only', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_wkrs00000001', h, null);
  k_read   := public.api_key_create(a, ws_a, null, 'read', array['n8n:read','n8n:jobs'], 'pis_live_wkrr00000001', h, null);
  k_b      := public.api_key_create(b, ws_b, null, 'B', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_wkrb00000001', h, null);

  select (x.job->>'job_id')::uuid into job from public.n8n_create_sync_job(k_a, s_a, 'n8n', true, '{}'::jsonb, 'w-idem-1', h, 'req-create-1') x;

  -- ---------- n8n_start_sync_job: ownership ----------
  begin perform public.n8n_start_sync_job(k_b, job, 'req-1', 'worker-bbbbbbbb');
    bad := bad + 1; r := r || 'FAIL another workspace started the job' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_found' then ok := ok + 1; r := r || 'PASS another workspace cannot start the job (job_not_found)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross ws: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_start_sync_job(k_store2, job, 'req-1', 'worker-ssssssss');
    bad := bad + 1; r := r || 'FAIL store-restricted key started another store job' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_found' then ok := ok + 1; r := r || 'PASS a key restricted to another store cannot start it' || E'\n';
    else bad := bad + 1; r := r || 'FAIL restricted: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_start_sync_job(k_read, job, 'req-1', 'worker-rrrrrrrr');
    bad := bad + 1; r := r || 'FAIL read-only key started a job' || E'\n';
  exception when others then
    if sqlerrm = 'insufficient_scope' then ok := ok + 1; r := r || 'PASS starting requires scope n8n:sync' || E'\n';
    else bad := bad + 1; r := r || 'FAIL scope: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_start_sync_job(k_a, job, 'req-1', 'bad id');
    bad := bad + 1; r := r || 'FAIL invalid worker id accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS invalid worker ids rejected' || E'\n'; end;

  -- ---------- claim: one worker ----------
  select * into rec from public.n8n_start_sync_job(k_a, job, 'req-run-1', 'worker-one-0001');
  if rec.claimed and rec.reason = 'claimed' and rec.job->>'status' = 'running' then
    ok := ok + 1; r := r || 'PASS queued → running, claimed by one worker' || E'\n';
  else bad := bad + 1; r := r || 'FAIL claim: ' || rec.reason || E'\n'; end if;
  select * into rec from public.n8n_start_sync_job(k_a, job, 'req-run-2', 'worker-two-0002');
  select worker_id into v from public.sync_jobs where id = job;
  if not rec.claimed and rec.reason = 'already_running' and v = 'worker-one-0001' then
    ok := ok + 1; r := r || 'PASS a second worker cannot claim a running job (lease alive)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL double claim: ' || rec.reason || E'\n'; end if;
  select count(*) into n from public.activity_logs where event_type = 'sync_job_started' and (metadata->>'job_id')::uuid = job;
  if n = 1 then ok := ok + 1; r := r || 'PASS start is logged once' || E'\n';
  else bad := bad + 1; r := r || 'FAIL start log: ' || n || E'\n'; end if;

  -- ---------- heartbeat / lease ----------
  j := public.sync_job_heartbeat(ws_a, job, 'worker-one-0001', '{"total":3,"processed":1,"uploaded":0,"skipped":1,"review":1,"failed":0}');
  select items_total || '/' || products_processed || '/' || items_review into v from public.sync_jobs where id = job;
  if v = '3/1/1' and (j->>'dry_run')::boolean and not (j->>'cancel_requested')::boolean and (j->>'store_id')::uuid = s_a then
    ok := ok + 1; r := r || 'PASS heartbeat stores progress and returns store / dry_run / cancel flag from the row' || E'\n';
  else bad := bad + 1; r := r || 'FAIL heartbeat: ' || v || E'\n'; end if;
  select (x.job->'progress'->>'review')::int into n from (select public.n8n_get_sync_job(k_a, job) as job) x;
  if n = 1 then ok := ok + 1; r := r || 'PASS n8n GET /sync-jobs/{id} shows the worker progress' || E'\n';
  else bad := bad + 1; r := r || 'FAIL n8n progress: ' || coalesce(n::text, 'null') || E'\n'; end if;
  begin perform public.sync_job_heartbeat(ws_a, job, 'worker-two-0002', null);
    bad := bad + 1; r := r || 'FAIL non-owner heartbeat accepted' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_owned' then ok := ok + 1; r := r || 'PASS only the owning worker can report progress' || E'\n';
    else bad := bad + 1; r := r || 'FAIL non-owner: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.sync_job_heartbeat(ws_b, job, 'worker-one-0001', null);
    bad := bad + 1; r := r || 'FAIL wrong workspace heartbeat accepted' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_found' then ok := ok + 1; r := r || 'PASS wrong workspace → job_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL wrong ws: ' || sqlerrm || E'\n'; end if; end;

  -- ---------- items (one per product folder per job) ----------
  it := public.sync_item_record(ws_a, job, 'worker-one-0001', jsonb_build_object(
    'drive_folder_id', 'prodMilanoxxxxx', 'drive_folder_name', 'Milano', 'category_root_id', 'sofaFolderId001',
    'code_folder_id', 'codeSof001xxxx', 'code_folder_name', 'SOF-001', 'shopify_product_id', 'gid://shopify/Product/1',
    'shopify_product_title', 'Milano', 'product_status', 'ACTIVE', 'status', 'matched', 'images_found', 2,
    'match_candidates', '[{"id":"gid://shopify/Product/1","title":"Milano","status":"ACTIVE"}]'::jsonb, 'error_message', null));
  it2 := public.sync_item_record(ws_a, job, 'worker-one-0001', jsonb_build_object(
    'drive_folder_id', 'prodMilanoxxxxx', 'drive_folder_name', 'Milano', 'category_root_id', 'sofaFolderId001',
    'code_folder_id', 'codeSof001xxxx', 'code_folder_name', 'SOF-001', 'status', 'matched', 'images_found', 3, 'match_candidates', '[]'::jsonb));
  select count(*) into n from public.sync_items where sync_job_id = job;
  if it = it2 and n = 1 then ok := ok + 1; r := r || 'PASS re-recording a product folder updates the same item (idempotent restart)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL item upsert: ' || n || E'\n'; end if;
  perform public.sync_item_update(ws_a, job, 'worker-one-0001', it, 'synced', 2, 1, 0, null);
  select status || '/' || images_uploaded || '/' || images_skipped into v from public.sync_items where id = it;
  if v = 'synced/2/1' then ok := ok + 1; r := r || 'PASS item result recorded' || E'\n';
  else bad := bad + 1; r := r || 'FAIL item update: ' || v || E'\n'; end if;
  begin perform public.sync_item_record(ws_a, job, 'worker-one-0001', jsonb_build_object('drive_folder_id', 'x', 'status', 'uploaded_everything'));
    bad := bad + 1; r := r || 'FAIL invalid item status accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS invalid item status rejected' || E'\n'; end;
  begin perform public.sync_item_update(ws_a, job, 'worker-two-0002', it, 'synced', 0, 0, 0, null);
    bad := bad + 1; r := r || 'FAIL non-owner item update' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS non-owner cannot write items' || E'\n'; end;

  -- ---------- crash recovery ----------
  update public.sync_jobs set heartbeat_at = now() - interval '20 minutes' where id = job;
  select * into rec from public.n8n_start_sync_job(k_a, job, 'req-run-3', 'worker-three-03');
  if rec.claimed and rec.reason = 'reclaimed' then ok := ok + 1; r := r || 'PASS stale lease → re-claimed by a new worker (crash recovery)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL reclaim: ' || rec.reason || E'\n'; end if;
  begin perform public.sync_job_heartbeat(ws_a, job, 'worker-one-0001', null);
    bad := bad + 1; r := r || 'FAIL old worker still owns the job' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_owned' then ok := ok + 1; r := r || 'PASS the old worker loses the lease' || E'\n';
    else bad := bad + 1; r := r || 'FAIL old worker: ' || sqlerrm || E'\n'; end if; end;

  -- ---------- cancellation ----------
  perform public.n8n_cancel_sync_job(k_a, job, 'req-cancel');
  j := public.sync_job_heartbeat(ws_a, job, 'worker-three-03', null);
  if (j->>'cancel_requested')::boolean then ok := ok + 1; r := r || 'PASS cancel requested on a running job reaches the worker' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cancel flag' || E'\n'; end if;

  -- ---------- finish ----------
  begin perform public.sync_job_finish(ws_a, job, 'worker-three-03', 'running', null, null, '{}', '{}');
    bad := bad + 1; r := r || 'FAIL non-terminal finish accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS finish only with a terminal status' || E'\n'; end;
  j := public.sync_job_finish(ws_a, job, 'worker-three-03', 'cancelled', null, null,
    '{"total":3,"processed":1,"uploaded":0,"skipped":1,"review":1,"failed":0}', '{"dry_run":true,"plan":{"would_upload":2}}');
  select status || '/' || coalesce(worker_id, '-') || '/' || (cancelled_at is not null)::text || '/' || (completed_at is not null)::text into v from public.sync_jobs where id = job;
  if v = 'cancelled/-/true/true' and j->>'status' = 'cancelled' and j->'result'->'plan'->>'would_upload' = '2' then
    ok := ok + 1; r := r || 'PASS finish: terminal state, lease released, result in the job JSON' || E'\n';
  else bad := bad + 1; r := r || 'FAIL finish: ' || v || ' ' || j::text || E'\n'; end if;
  select * into rec from public.n8n_start_sync_job(k_a, job, 'req-run-4', 'worker-four-004');
  if not rec.claimed and rec.reason = 'finished' then ok := ok + 1; r := r || 'PASS a finished job is never re-claimed' || E'\n';
  else bad := bad + 1; r := r || 'FAIL finished reclaim: ' || rec.reason || E'\n'; end if;
  begin perform public.sync_job_finish(ws_a, job, 'worker-three-03', 'completed', null, null, '{}', '{}');
    bad := bad + 1; r := r || 'FAIL finished twice' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS a finished job cannot be finished again' || E'\n'; end;
  select count(*) into n from public.activity_logs where event_type = 'sync_job_finished' and (metadata->>'job_id')::uuid = job;
  if n = 1 then ok := ok + 1; r := r || 'PASS finish logged once' || E'\n';
  else bad := bad + 1; r := r || 'FAIL finish log: ' || n || E'\n'; end if;

  -- ---------- server-side claim ----------
  select (x.job->>'job_id')::uuid into job2 from public.n8n_create_sync_job(k_a, s_a, 'n8n', false, '{}'::jsonb, 'w-idem-2', h, 'req-create-2') x;
  begin perform public.sync_job_claim(ws_b, job2, 'worker-srv-0001', 900);
    bad := bad + 1; r := r || 'FAIL server claim from another workspace' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS server-side claim checks the workspace' || E'\n'; end;
  select * into rec from public.sync_job_claim(ws_a, job2, 'worker-srv-0001', 900);
  if rec.claimed then ok := ok + 1; r := r || 'PASS server-side claim works for the owning workspace' || E'\n';
  else bad := bad + 1; r := r || 'FAIL server claim' || E'\n'; end if;

  -- no sync_images rows were touched by any of this
  select count(*) into n from public.sync_images where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS job/item functions never write sync_images' || E'\n';
  else bad := bad + 1; r := r || 'FAIL sync_images: ' || n || E'\n'; end if;

  -- ---------- signed-in users ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin perform public.sync_job_heartbeat(ws_a, job2, 'worker-srv-0001', null);
    bad := bad + 1; r := r || 'FAIL a signed-in user called a worker function' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot call worker functions' || E'\n'; end;

  raise exception '%', r || E'\nsync worker tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
