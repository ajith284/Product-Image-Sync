-- n8n API database tests (Prompt 8). One transaction, ends with RAISE EXCEPTION,
-- so everything is rolled back. Run with the Supabase MCP execute_sql tool.
do $test$
declare
  a uuid := gen_random_uuid();  -- owner, workspace A
  m uuid := gen_random_uuid();  -- member in A
  b uuid := gen_random_uuid();  -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_a2 uuid; s_b uuid;
  k_wide uuid; k_store uuid; k_read uuid; k_b uuid; k_rev uuid; k_exp uuid;
  h1 text := repeat('1', 64); h2 text := repeat('2', 64);
  j jsonb; j2 jsonb; rep boolean; n int; t text; ok_ boolean; rec record;
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  -- ---------- setup ----------
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.local'
  from unnest(array[a, m, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, m, 'member');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'BrandSure', 'n8n-test-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Second', 'n8n-test-a2.myshopify.com') returning id into s_a2;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'Other', 'n8n-test-b.myshopify.com') returning id into s_b;
  -- A fully connected store (Shopify + Drive + root folder) in each workspace.
  insert into public.shopify_connections (store_id, shop_domain, connection_status) values
    (s_a, 'n8n-test-a.myshopify.com', 'connected'), (s_a2, 'n8n-test-a2.myshopify.com', 'connected'), (s_b, 'n8n-test-b.myshopify.com', 'connected');
  insert into public.google_drive_connections (store_id, connection_status, root_folder_id, root_folder_name) values
    (s_a, 'connected', 'sofaFolderId001', 'Sofa'), (s_a2, 'connected', null, null), (s_b, 'connected', 'bFolder', 'B');

  -- ================= key management (service role, as the app) =================
  perform set_config('role', 'service_role', true);
  begin perform public.api_key_create(m, ws_a, null, 'member key', array['n8n:read'], 'pis_live_aaaaaaaaaaaa', h1, null);
    bad := bad + 1; r := r || 'FAIL member created a key' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot create API keys' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member create: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.api_key_create(a, ws_a, s_b, 'cross', array['n8n:read'], 'pis_live_bbbbbbbbbbbb', h1, null);
    bad := bad + 1; r := r || 'FAIL key restricted to another workspace store' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS cannot restrict a key to another workspace''s store' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross store: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.api_key_create(a, ws_a, null, 'bad scope', array['n8n:admin'], 'pis_live_cccccccccccc', h1, null);
    bad := bad + 1; r := r || 'FAIL unknown scope accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS unknown scopes rejected' || E'\n'; end;
  begin perform public.api_key_create(a, ws_a, null, 'plain', array['n8n:read'], 'pis_live_dddddddddddd', 'plaintext-secret', null);
    bad := bad + 1; r := r || 'FAIL non-hash secret stored' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS only a SHA-256 hash can be stored (no plaintext)' || E'\n'; end;

  k_wide  := public.api_key_create(a, ws_a, null, 'n8n wide', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_wide00000001', h1, null);
  k_store := public.api_key_create(a, ws_a, s_a, 'n8n BrandSure', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_store0000001', h1, null);
  k_read  := public.api_key_create(a, ws_a, null, 'read only', array['n8n:read'], 'pis_live_read00000001', h1, null);
  k_b     := public.api_key_create(b, ws_b, null, 'B wide', array['n8n:read','n8n:sync','n8n:jobs'], 'pis_live_bbbb00000001', h2, null);
  k_rev   := public.api_key_create(a, ws_a, null, 'revoked', array['n8n:read'], 'pis_live_revk00000001', h1, null);
  k_exp   := public.api_key_create(a, ws_a, null, 'expiring', array['n8n:read'], 'pis_live_expd00000001', h1, now() + interval '1 hour');
  update internal.api_keys set expires_at = now() - interval '1 second' where id = k_exp;
  ok := ok + 1; r := r || 'PASS owners create workspace-wide and store-restricted keys' || E'\n';

  select count(*) into n from public.api_keys_list(a, ws_a);
  select count(*) into n from public.api_keys_list(a, ws_a) l where l.key_prefix like 'pis_live_%';
  if n = 5 then ok := ok + 1; r := r || 'PASS key list = this workspace only (metadata, no hash column)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL list count ' || n || E'\n'; end if;
  begin perform public.api_keys_list(m, ws_a);
    bad := bad + 1; r := r || 'FAIL member listed keys' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS member cannot list keys' || E'\n'; end;
  begin perform public.api_key_revoke(b, k_wide);
    bad := bad + 1; r := r || 'FAIL other workspace revoked key' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS other workspace cannot revoke our key' || E'\n'; end;
  if public.api_key_revoke(a, k_rev) and not public.api_key_revoke(a, k_rev) then ok := ok + 1; r := r || 'PASS revoke works and is idempotent' || E'\n';
  else bad := bad + 1; r := r || 'FAIL revoke' || E'\n'; end if;

  -- ================= authentication =================
  select count(*) into n from public.n8n_authenticate('pis_live_wide00000001');
  if n = 1 then ok := ok + 1; r := r || 'PASS valid key found by prefix' || E'\n'; else bad := bad + 1; r := r || 'FAIL auth valid' || E'\n'; end if;
  select count(*) into n from public.n8n_authenticate('pis_live_revk00000001');
  if n = 0 then ok := ok + 1; r := r || 'PASS revoked key stops working immediately' || E'\n'; else bad := bad + 1; r := r || 'FAIL revoked authenticates' || E'\n'; end if;
  select count(*) into n from public.n8n_authenticate('pis_live_expd00000001');
  if n = 0 then ok := ok + 1; r := r || 'PASS expired key rejected' || E'\n'; else bad := bad + 1; r := r || 'FAIL expired authenticates' || E'\n'; end if;
  select count(*) into n from public.n8n_authenticate('pis_live_nope00000000');
  if n = 0 then ok := ok + 1; r := r || 'PASS unknown key rejected' || E'\n'; else bad := bad + 1; r := r || 'FAIL unknown' || E'\n'; end if;
  begin perform public.n8n_store_status(k_rev, s_a);
    bad := bad + 1; r := r || 'FAIL revoked key used directly' || E'\n';
  exception when others then
    if sqlerrm = 'invalid_api_key' then ok := ok + 1; r := r || 'PASS every RPC re-checks the key (revoked → invalid_api_key)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL revoked rpc: ' || sqlerrm || E'\n'; end if; end;

  -- ================= store status / authorization =================
  j := public.n8n_store_status(k_wide, s_a);
  if j->>'store_name' = 'BrandSure' and (j->'shopify'->>'connected')::boolean and (j->'google_drive'->>'root_folder_name') = 'Sofa'
     and (j->>'ready_for_sync')::boolean and j::text !~ '(token|secret|v1\.)' then
    ok := ok + 1; r := r || 'PASS store status: safe fields, ready_for_sync, no secrets' || E'\n';
  else bad := bad + 1; r := r || 'FAIL status ' || j::text || E'\n'; end if;
  begin perform public.n8n_store_status(k_wide, s_b);
    bad := bad + 1; r := r || 'FAIL workspace A key read workspace B store' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS workspace A key → workspace B store: store_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross ws: ' || sqlerrm || E'\n'; end if; end;
  j := public.n8n_store_status(k_store, s_a);
  ok := ok + 1; r := r || 'PASS store-restricted key → its store' || E'\n';
  begin perform public.n8n_store_status(k_store, s_a2);
    bad := bad + 1; r := r || 'FAIL store-restricted key read other store' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS store-restricted key → other store (same workspace): store_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL restricted: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_create_sync_job(k_read, s_a, 'n8n', false, '{}', 'x', h1, 'r');
    bad := bad + 1; r := r || 'FAIL read-only key created a job' || E'\n';
  exception when others then
    if sqlerrm = 'insufficient_scope' then ok := ok + 1; r := r || 'PASS read-only key cannot create jobs (insufficient_scope)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL scope: ' || sqlerrm || E'\n'; end if; end;

  -- ================= create job + idempotency =================
  select c.job, c.replayed into j, rep from public.n8n_create_sync_job(k_wide, s_a, 'n8n', false, '{"category":"Sofa"}', 'idem-1', h1, 'req-1') c;
  select count(*) into n from public.sync_jobs where id = (j->>'job_id')::uuid and workspace_id = ws_a and status = 'queued'
    and trigger_type = 'n8n' and requested_by_api_key = k_wide and idempotency_key = 'idem-1';
  if n = 1 and not rep and j->>'status' = 'queued' and (j->'progress'->>'total')::int = 0 then
    ok := ok + 1; r := r || 'PASS first request creates a queued job (workspace set server-side)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL create ' || coalesce(j::text, 'null') || E'\n'; end if;
  select c.job, c.replayed into j2, rep from public.n8n_create_sync_job(k_wide, s_a, 'n8n', false, '{"category":"Sofa"}', 'idem-1', h1, 'req-2') c;
  select count(*) into n from public.sync_jobs where store_id = s_a;
  if rep and j2->>'job_id' = j->>'job_id' and n = 1 then ok := ok + 1; r := r || 'PASS identical retry returns the original job (no duplicate)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL replay' || E'\n'; end if;
  begin perform public.n8n_create_sync_job(k_wide, s_a2, 'n8n', false, '{}', 'idem-1', h1, 'req-3');
    bad := bad + 1; r := r || 'FAIL same idempotency key reused for another store' || E'\n';
  exception when others then
    if sqlerrm = 'idempotency_conflict' then ok := ok + 1; r := r || 'PASS same Idempotency-Key on a different store → idempotency_conflict' || E'\n';
    else bad := bad + 1; r := r || 'FAIL idem other store: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_create_sync_job(k_wide, s_a, 'n8n', true, '{}', 'idem-1', h2, 'req-4');
    bad := bad + 1; r := r || 'FAIL same key, different body accepted' || E'\n';
  exception when others then
    if sqlerrm = 'idempotency_conflict' then ok := ok + 1; r := r || 'PASS same Idempotency-Key with a different body → idempotency_conflict' || E'\n';
    else bad := bad + 1; r := r || 'FAIL idem body: ' || sqlerrm || E'\n'; end if; end;
  -- Workspace B may use the SAME key string independently (not global).
  select c.job into j2 from public.n8n_create_sync_job(k_b, s_b, 'n8n', false, '{}', 'idem-1', h1, 'req-b') c;
  if j2->>'store_id' = s_b::text then ok := ok + 1; r := r || 'PASS idempotency keys are scoped per workspace (B can reuse "idem-1")' || E'\n';
  else bad := bad + 1; r := r || 'FAIL idem scope' || E'\n'; end if;
  begin perform public.n8n_create_sync_job(k_wide, s_a, 'n8n', false, '{}', 'idem-2', h1, 'req-5');
    bad := bad + 1; r := r || 'FAIL second active job created' || E'\n';
  exception when others then
    if sqlerrm = 'sync_job_already_active' then ok := ok + 1; r := r || 'PASS one active (queued/running) job per store' || E'\n';
    else bad := bad + 1; r := r || 'FAIL active: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_create_sync_job(k_wide, s_a2, 'n8n', false, '{}', 'idem-3', h1, 'req-6');
    bad := bad + 1; r := r || 'FAIL job without root folder' || E'\n';
  exception when others then
    if sqlerrm = 'google_drive_root_not_selected' then ok := ok + 1; r := r || 'PASS no root folder → google_drive_root_not_selected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL root: ' || sqlerrm || E'\n'; end if; end;
  update public.google_drive_connections set connection_status = 'needs_reconnect' where store_id = s_a2;
  begin perform public.n8n_create_sync_job(k_wide, s_a2, 'n8n', false, '{}', 'idem-3', h1, 'req-7');
    bad := bad + 1; r := r || 'FAIL job without drive' || E'\n';
  exception when others then
    if sqlerrm = 'google_drive_not_connected' then ok := ok + 1; r := r || 'PASS Drive not connected → google_drive_not_connected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL drive: ' || sqlerrm || E'\n'; end if; end;
  update public.shopify_connections set connection_status = 'disconnected' where store_id = s_a2;
  begin perform public.n8n_create_sync_job(k_wide, s_a2, 'n8n', false, '{}', 'idem-3', h1, 'req-8');
    bad := bad + 1; r := r || 'FAIL job without shopify' || E'\n';
  exception when others then
    if sqlerrm = 'shopify_not_connected' then ok := ok + 1; r := r || 'PASS Shopify not connected → shopify_not_connected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL shopify: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_create_sync_job(k_wide, s_b, 'n8n', false, '{}', 'idem-9', h1, 'req-9');
    bad := bad + 1; r := r || 'FAIL forged store id (other workspace) accepted' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS forged store_id from another workspace → store_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL forged store: ' || sqlerrm || E'\n'; end if; end;
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'sync_job_queued' and metadata ? 'request_id' and metadata::text !~ 'secret';
  if n = 1 then ok := ok + 1; r := r || 'PASS job creation audited (request id + key id, no secrets)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL audit ' || n || E'\n'; end if;

  -- ================= get / list / cancel =================
  j2 := public.n8n_get_sync_job(k_store, (j->>'job_id')::uuid);
  if j2->>'job_id' = j->>'job_id' then ok := ok + 1; r := r || 'PASS get job (store-restricted key, own store)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL get' || E'\n'; end if;
  select c.job into j2 from public.n8n_create_sync_job(k_b, s_b, 'n8n', false, '{}', 'idem-1', h1, 'req-b') c; -- B's job (replay)
  begin perform public.n8n_get_sync_job(k_wide, (j2->>'job_id')::uuid);
    bad := bad + 1; r := r || 'FAIL read other workspace job' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_found' then ok := ok + 1; r := r || 'PASS forged job_id from another workspace → job_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL forged job: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.n8n_cancel_sync_job(k_wide, (j2->>'job_id')::uuid, 'x');
    bad := bad + 1; r := r || 'FAIL cancel other workspace job' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS cannot cancel another workspace''s job' || E'\n'; end;

  -- extra history rows for pagination (completed jobs)
  insert into public.sync_jobs (store_id, status, trigger_type, created_at, started_at, completed_at)
  select s_a, 'completed', 'scheduled', now() - make_interval(mins => g), now() - make_interval(mins => g), now() - make_interval(mins => g)
  from generate_series(1, 5) g;
  select count(*) into n from public.n8n_list_sync_jobs(k_wide, null, null, 2, null, null);
  if n = 3 then ok := ok + 1; r := r || 'PASS list returns limit+1 rows (next-page detection)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL list limit ' || n || E'\n'; end if;
  select count(*) into n from public.n8n_list_sync_jobs(k_wide, null, null, 100, null, null);
  if n = 6 then ok := ok + 1; r := r || 'PASS list shows only workspace A jobs (6), never B''s' || E'\n';
  else bad := bad + 1; r := r || 'FAIL list ws ' || n || E'\n'; end if;
  select count(*) into n from public.n8n_list_sync_jobs(k_wide, s_a, 'queued', 20, null, null);
  if n = 1 then ok := ok + 1; r := r || 'PASS list filters by store and status' || E'\n';
  else bad := bad + 1; r := r || 'FAIL filter ' || n || E'\n'; end if;
  select x->>'created_at' as c, x->>'job_id' as i into rec from public.n8n_list_sync_jobs(k_wide, null, null, 2, null, null) x offset 1 limit 1;
  select count(*) into n from public.n8n_list_sync_jobs(k_wide, null, null, 100, rec.c::timestamptz, rec.i::uuid);
  if n = 4 then ok := ok + 1; r := r || 'PASS keyset cursor continues after the last row' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cursor ' || n || E'\n'; end if;
  begin perform public.n8n_list_sync_jobs(k_store, s_a2, null, 20, null, null);
    bad := bad + 1; r := r || 'FAIL restricted key listed other store' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS store-restricted key cannot list another store' || E'\n'; end;

  select c.job, c.changed into j2, rep from public.n8n_cancel_sync_job(k_wide, (j->>'job_id')::uuid, 'req-c1') c;
  if rep and j2->>'status' = 'cancelled' then ok := ok + 1; r := r || 'PASS cancel queued job → cancelled' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cancel' || E'\n'; end if;
  select c.job, c.changed into j2, rep from public.n8n_cancel_sync_job(k_wide, (j->>'job_id')::uuid, 'req-c2') c;
  if not rep and j2->>'status' = 'cancelled' then ok := ok + 1; r := r || 'PASS cancelling again is a no-op (idempotent, no error)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cancel twice' || E'\n'; end if;
  begin perform public.n8n_cancel_sync_job(k_wide, (select id from public.sync_jobs where store_id = s_a and status = 'completed' limit 1), 'x');
    bad := bad + 1; r := r || 'FAIL completed job cancelled' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_cancellable' then ok := ok + 1; r := r || 'PASS completed job is not cancellable' || E'\n';
    else bad := bad + 1; r := r || 'FAIL not cancellable: ' || sqlerrm || E'\n'; end if; end;
  -- running job: cancel = request only
  select c.job into j from public.n8n_create_sync_job(k_wide, s_a, 'n8n', false, '{}', 'idem-run', h1, 'req-r') c;
  update public.sync_jobs set status = 'running', started_at = now() where id = (j->>'job_id')::uuid;
  select c.job, c.changed into j2, rep from public.n8n_cancel_sync_job(k_wide, (j->>'job_id')::uuid, 'req-c3') c;
  if rep and j2->>'status' = 'running' and (j2->>'cancel_requested')::boolean then ok := ok + 1; r := r || 'PASS running job → cancel requested (worker stops later)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL running cancel' || E'\n'; end if;

  -- ================= nonces / rate limits =================
  if public.n8n_use_nonce(k_wide, 'nonce-12345678', 600) and not public.n8n_use_nonce(k_wide, 'nonce-12345678', 600)
     and public.n8n_use_nonce(k_b, 'nonce-12345678', 600) then
    ok := ok + 1; r := r || 'PASS nonce accepted once per key (replay rejected)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL nonce' || E'\n'; end if;
  for n in 1..3 loop select * into rec from public.n8n_rate_limit_hit('test:bucket', 3, 60); end loop;
  ok_ := rec.allowed;
  select * into rec from public.n8n_rate_limit_hit('test:bucket', 3, 60);
  if ok_ and not rec.allowed and rec.retry_after between 1 and 60 then ok := ok + 1; r := r || 'PASS rate limit: 4th call in window refused with retry_after' || E'\n';
  else bad := bad + 1; r := r || 'FAIL rate limit' || E'\n'; end if;

  -- ================= browser roles: no access =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin perform count(*) from internal.api_keys;
    bad := bad + 1; r := r || 'FAIL browser read api_keys' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot read internal.api_keys' || E'\n'; end;
  begin perform public.n8n_authenticate('pis_live_wide00000001');
    bad := bad + 1; r := r || 'FAIL browser called n8n_authenticate' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot call n8n RPCs (a session can''t act as n8n)' || E'\n'; end;
  begin perform public.api_key_create(a, ws_a, null, 'x', array['n8n:read'], 'pis_live_zzzzzzzzzzzz', h1, null);
    bad := bad + 1; r := r || 'FAIL browser created key via RPC' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot call key-management RPCs directly' || E'\n'; end;
  select count(*) into n from public.sync_jobs;
  if n >= 1 and not exists (select 1 from public.sync_jobs where workspace_id = ws_b) then
    ok := ok + 1; r := r || 'PASS members see their workspace''s jobs only (RLS)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL jobs rls' || E'\n'; end if;
  perform set_config('role', 'anon', true);
  begin perform count(*) from internal.api_rate_limits;
    bad := bad + 1; r := r || 'FAIL anon read rate limits' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot read API tables' || E'\n'; end;
  perform set_config('role', 'service_role', true);

  raise exception 'N8N API DB TESTS (rolled back): % passed, % failed%', ok, bad, r;
end;
$test$;
