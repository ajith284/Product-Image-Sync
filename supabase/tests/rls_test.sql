-- RLS / constraint test suite. Runs entirely inside one transaction and ends
-- with RAISE EXCEPTION, so every row it creates is rolled back.
do $test$
declare
  a uuid := gen_random_uuid();   -- owner of workspace A
  b uuid := gen_random_uuid();   -- owner of workspace B (outsider to A)
  c uuid := gen_random_uuid();   -- member in A
  d uuid := gen_random_uuid();   -- admin in A
  e uuid := gen_random_uuid();   -- not in any workspace yet
  ws_a uuid; ws_b uuid; s_a uuid; s_b uuid; job_a uuid; job_b uuid; item_a uuid; conn_a uuid;
  n int; r text := E'\n';
  ok int := 0; bad int := 0;
begin
  -- ---------- setup (as postgres) ----------
  insert into auth.users (id, instance_id, aud, role, email)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u::text || '@test.local'
  from unnest(array[a, b, c, d, e]) u;

  select count(*) into n from public.profiles where id in (a, b, c, d, e);
  if n = 5 then ok := ok + 1; r := r || 'PASS profiles auto-created on signup' || E'\n';
  else bad := bad + 1; r := r || 'FAIL profiles auto-created: ' || n || E'\n'; end if;

  -- act as A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select id into ws_a from public.create_workspace('Royal Sofa', 'royal-sofa');
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, c, 'member'), (ws_a, d, 'admin');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Royal Sofa', 'royal-sofa.myshopify.com') returning id into s_a;

  -- act as B
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select id into ws_b from public.create_workspace('Other Co', null);
  insert into public.stores (workspace_id, name) values (ws_b, 'Other Store') returning id into s_b;

  -- server-side data (as postgres = service-level)
  perform set_config('role', 'postgres', true);
  insert into public.shopify_connections (store_id, shop_domain, connection_status) values (s_a, 'royal-sofa.myshopify.com', 'connected') returning id into conn_a;
  insert into public.google_drive_connections (store_id, root_folder_id) values (s_a, 'folder123');
  insert into internal.integration_secrets (connection_id, provider, encrypted_access_token) values (conn_a, 'shopify', 'ciphertext-not-a-real-token');
  insert into public.sync_jobs (store_id, status) values (s_a, 'completed') returning id into job_a;
  insert into public.sync_jobs (store_id) values (s_b) returning id into job_b;
  insert into public.sync_items (sync_job_id, store_id, drive_folder_id, drive_folder_name, status) values (job_a, s_a, 'f1', 'Milano', 'synced') returning id into item_a;
  insert into public.sync_images (sync_item_id, store_id, shopify_product_id, drive_file_id, filename, upload_status) values (item_a, s_a, 'gid://shopify/Product/1', 'file1', 'image-01.jpg', 'uploaded');
  insert into public.sync_errors (sync_job_id, store_id, error_type, message) values (job_a, s_a, 'no_product_found', 'No Shopify product matched "Roma".');
  insert into public.activity_logs (workspace_id, store_id, event_type, message) values (ws_a, s_a, 'sync_started', 'Started Royal Sofa sync');

  -- ================= 1. A can access own workspace =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select (select count(*) from public.workspaces) * 1000000
       + (select count(*) from public.stores) * 100000
       + (select count(*) from public.store_settings) * 10000
       + (select count(*) from public.sync_jobs) * 1000
       + (select count(*) from public.sync_images) * 100
       + (select count(*) from public.activity_logs) * 10
       + (select count(*) from public.shopify_connections) into n;
  if n = 1111111 then ok := ok + 1; r := r || 'PASS owner A sees exactly own workspace/store/settings/jobs/images/logs/connection' || E'\n';
  else bad := bad + 1; r := r || 'FAIL owner A visibility code ' || n || E'\n'; end if;

  select count(*) into n from public.profiles;
  if n = 3 then ok := ok + 1; r := r || 'PASS A sees own + co-member profiles only (3)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL A profile count ' || n || E'\n'; end if;

  -- ================= 2. B cannot access A's workspace =================
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select (select count(*) from public.workspaces where id = ws_a)
       + (select count(*) from public.stores where id = s_a)
       + (select count(*) from public.sync_jobs where store_id = s_a)
       + (select count(*) from public.sync_items where store_id = s_a)
       + (select count(*) from public.sync_errors where store_id = s_a)
       + (select count(*) from public.activity_logs where workspace_id = ws_a)
       + (select count(*) from public.workspace_members where workspace_id = ws_a)
       + (select count(*) from public.shopify_connections where store_id = s_a)
       + (select count(*) from public.profiles where id = a) into n;
  if n = 0 then ok := ok + 1; r := r || 'PASS B sees none of workspace A data' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B saw ' || n || ' rows of A' || E'\n'; end if;

  update public.stores set name = 'hacked' where id = s_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS B cannot rename A store' || E'\n'; else bad := bad + 1; r := r || 'FAIL B renamed A store' || E'\n'; end if;
  delete from public.workspaces where id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS B cannot delete workspace A' || E'\n'; else bad := bad + 1; r := r || 'FAIL B deleted workspace A' || E'\n'; end if;

  begin insert into public.stores (workspace_id, name) values (ws_a, 'intruder');
    bad := bad + 1; r := r || 'FAIL B inserted store into A' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS B cannot add store to A (' || sqlstate || ')' || E'\n'; end;

  begin insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, e, 'member');
    bad := bad + 1; r := r || 'FAIL B added member to A' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS B cannot add member to A (' || sqlstate || ')' || E'\n'; end;

  begin insert into public.product_mappings (store_id, drive_folder_id, shopify_product_id, mapping_type) values (s_a, 'x', 'y', 'manual');
    bad := bad + 1; r := r || 'FAIL B created mapping in A' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS B cannot create mapping in A (' || sqlstate || ')' || E'\n'; end;

  -- ================= 3. Members cannot escalate =================
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  update public.workspace_members set role = 'owner' where user_id = c and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS member C cannot make self owner' || E'\n'; else bad := bad + 1; r := r || 'FAIL member C became owner' || E'\n'; end if;
  update public.workspace_members set role = 'admin' where user_id = c and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS member C cannot make self admin' || E'\n'; else bad := bad + 1; r := r || 'FAIL member C became admin' || E'\n'; end if;
  update public.workspace_members set role = 'member' where user_id = a and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS member C cannot demote owner' || E'\n'; else bad := bad + 1; r := r || 'FAIL member C demoted owner' || E'\n'; end if;
  begin insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, e, 'member');
    bad := bad + 1; r := r || 'FAIL member C added a member' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS member C cannot add members (' || sqlstate || ')' || E'\n'; end;
  begin insert into public.stores (workspace_id, name) values (ws_a, 'member store');
    bad := bad + 1; r := r || 'FAIL member C created store' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS member C cannot create stores (' || sqlstate || ')' || E'\n'; end;
  update public.store_settings set auto_sync_enabled = true where store_id = s_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS member C cannot change store settings' || E'\n'; else bad := bad + 1; r := r || 'FAIL member C changed settings' || E'\n'; end if;
  begin insert into public.product_mappings (store_id, drive_folder_id, drive_folder_name, shopify_product_id, mapping_type) values (s_a, 'f2', 'Roma', 'gid://shopify/Product/2', 'manual');
    ok := ok + 1; r := r || 'PASS member C can create manual mapping' || E'\n';
  exception when others then bad := bad + 1; r := r || 'FAIL member C manual mapping: ' || sqlerrm || E'\n'; end;
  begin insert into public.product_mappings (store_id, drive_folder_id, shopify_product_id, mapping_type) values (s_a, 'f3', 'p3', 'automatic');
    bad := bad + 1; r := r || 'FAIL member created automatic mapping' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS users cannot write automatic mappings (' || sqlstate || ')' || E'\n'; end;

  -- admin D
  perform set_config('request.jwt.claims', json_build_object('sub', d, 'role', 'authenticated')::text, true);
  update public.workspace_members set role = 'admin' where user_id = c and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS admin D cannot promote others' || E'\n'; else bad := bad + 1; r := r || 'FAIL admin D promoted C' || E'\n'; end if;
  begin insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, e, 'admin');
    bad := bad + 1; r := r || 'FAIL admin D added an admin' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS admin D cannot add admins (' || sqlstate || ')' || E'\n'; end;
  delete from public.workspace_members where user_id = a and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; r := r || 'PASS admin D cannot remove owner' || E'\n'; else bad := bad + 1; r := r || 'FAIL admin D removed owner' || E'\n'; end if;
  begin
    update public.stores set status = 'connected' where id = s_a;
    bad := bad + 1; r := r || 'FAIL admin D changed server-managed store status' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS store.status is server-managed (' || sqlstate || ')' || E'\n'; end;
  update public.store_settings set auto_sync_enabled = true where store_id = s_a; get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; r := r || 'PASS admin D can change store settings' || E'\n'; else bad := bad + 1; r := r || 'FAIL admin D settings update' || E'\n'; end if;

  -- owner A
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, e, 'owner');
    bad := bad + 1; r := r || 'FAIL owner inserted second owner row' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS owner rows cannot be created via API (' || sqlstate || ')' || E'\n'; end;
  begin update public.workspace_members set role = 'owner' where user_id = c and workspace_id = ws_a;
    bad := bad + 1; r := r || 'FAIL owner promoted C to owner' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS cannot promote to owner (' || sqlstate || ')' || E'\n'; end;
  update public.workspace_members set role = 'admin' where user_id = c and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; r := r || 'PASS owner A can promote member to admin' || E'\n'; else bad := bad + 1; r := r || 'FAIL owner promote' || E'\n'; end if;
  begin update public.workspace_members set user_id = e where user_id = c and workspace_id = ws_a;
    bad := bad + 1; r := r || 'FAIL membership user_id changed' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS membership identity immutable (' || sqlstate || ')' || E'\n'; end;

  -- ================= 4. Duplicate membership =================
  begin insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, c, 'member');
    bad := bad + 1; r := r || 'FAIL duplicate membership allowed' || E'\n';
  exception when unique_violation then ok := ok + 1; r := r || 'PASS duplicate membership rejected (23505)' || E'\n';
            when others then bad := bad + 1; r := r || 'FAIL duplicate membership wrong error ' || sqlstate || E'\n'; end;

  -- ================= 6. Secrets not readable from frontend =================
  begin perform count(*) from internal.integration_secrets;
    bad := bad + 1; r := r || 'FAIL authenticated read integration_secrets' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS authenticated cannot read integration_secrets (' || sqlstate || ')' || E'\n'; end;
  begin perform count(*) from internal.oauth_states;
    bad := bad + 1; r := r || 'FAIL authenticated read oauth_states' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS authenticated cannot read oauth_states (' || sqlstate || ')' || E'\n'; end;
  begin insert into public.shopify_connections (store_id) values (s_a);
    bad := bad + 1; r := r || 'FAIL user wrote connection metadata' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS users cannot write connection metadata (' || sqlstate || ')' || E'\n'; end;
  begin insert into public.sync_jobs (store_id) values (s_a);
    bad := bad + 1; r := r || 'FAIL user wrote sync_jobs' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS users cannot write sync history (' || sqlstate || ')' || E'\n'; end;

  -- anon
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform count(*) from internal.integration_secrets;
    bad := bad + 1; r := r || 'FAIL anon read integration_secrets' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS anon cannot read integration_secrets (' || sqlstate || ')' || E'\n'; end;
  begin perform count(*) from public.workspaces;
    bad := bad + 1; r := r || 'FAIL anon read workspaces' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS anon has no table access (' || sqlstate || ')' || E'\n'; end;
  begin perform public.create_workspace('anon ws');
    bad := bad + 1; r := r || 'FAIL anon created workspace' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS anon cannot call create_workspace (' || sqlstate || ')' || E'\n'; end;

  -- ================= 5 + 8. Constraints (as postgres) =================
  perform set_config('role', 'postgres', true);
  begin insert into public.shopify_connections (store_id) values (s_a);
    bad := bad + 1; r := r || 'FAIL second Shopify connection allowed' || E'\n';
  exception when unique_violation then ok := ok + 1; r := r || 'PASS one Shopify connection per store (23505)' || E'\n'; end;
  begin insert into public.google_drive_connections (store_id) values (s_a);
    bad := bad + 1; r := r || 'FAIL second Drive connection allowed' || E'\n';
  exception when unique_violation then ok := ok + 1; r := r || 'PASS one Drive connection per store (23505)' || E'\n'; end;
  begin insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'x', 'https://evil.com');
    bad := bad + 1; r := r || 'FAIL invalid shop domain accepted' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS invalid shop domain rejected (23514)' || E'\n'; end;
  begin insert into public.stores (workspace_id, name, status) values (ws_a, 'x', 'bogus');
    bad := bad + 1; r := r || 'FAIL invalid store status accepted' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS invalid store status rejected (23514)' || E'\n'; end;
  begin update public.store_settings set allowed_image_types = array['gif'] where store_id = s_a;
    bad := bad + 1; r := r || 'FAIL gif allowed' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS unsupported image type rejected (23514)' || E'\n'; end;
  begin insert into public.sync_items (sync_job_id, store_id, drive_folder_id) values (job_a, s_b, 'f9');
    bad := bad + 1; r := r || 'FAIL sync item with mismatched store accepted' || E'\n';
  exception when foreign_key_violation then ok := ok + 1; r := r || 'PASS sync item must match its job store (23503)' || E'\n'; end;
  begin insert into public.activity_logs (workspace_id, store_id, event_type, message) values (ws_b, s_a, 'x', 'x');
    bad := bad + 1; r := r || 'FAIL cross-workspace activity log accepted' || E'\n';
  exception when foreign_key_violation then ok := ok + 1; r := r || 'PASS activity log store must be in same workspace (23503)' || E'\n'; end;
  begin insert into public.sync_images (store_id, shopify_product_id, drive_file_id, filename) values (s_a, 'gid://shopify/Product/1', 'file1', 'image-01.jpg');
    bad := bad + 1; r := r || 'FAIL duplicate image record allowed' || E'\n';
  exception when unique_violation then ok := ok + 1; r := r || 'PASS duplicate image per product rejected (23505)' || E'\n'; end;
  begin insert into public.sync_jobs (store_id, products_processed) values (s_a, -1);
    bad := bad + 1; r := r || 'FAIL negative counter accepted' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS negative counters rejected (23514)' || E'\n'; end;
  begin insert into public.workspaces (name, slug) values ('dup', 'royal-sofa');
    bad := bad + 1; r := r || 'FAIL duplicate slug accepted' || E'\n';
  exception when unique_violation then ok := ok + 1; r := r || 'PASS workspace slug unique (23505)' || E'\n'; end;

  select count(*) into n from public.store_settings
  where store_id = s_b and matching_mode = 'contains' and case_insensitive and trim_spaces
    and ignored_folders = array['OG'] and allowed_image_types = array['jpg','jpeg','png','webp']
    and auto_sync_enabled = false;
  if n = 1 then ok := ok + 1; r := r || 'PASS store_settings defaults created with store' || E'\n'; else bad := bad + 1; r := r || 'FAIL store_settings defaults' || E'\n'; end if;
  -- ================= cascade: deleting a connection removes its secrets =================
  delete from public.shopify_connections where id = conn_a;
  select count(*) into n from internal.integration_secrets where connection_id = conn_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS secrets removed with their connection' || E'\n'; else bad := bad + 1; r := r || 'FAIL orphan secret remained' || E'\n'; end if;

  -- ================= leave workspace =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', d, 'role', 'authenticated')::text, true);
  delete from public.workspace_members where user_id = d and workspace_id = ws_a; get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; r := r || 'PASS admin can leave workspace' || E'\n'; else bad := bad + 1; r := r || 'FAIL leave' || E'\n'; end if;
  select count(*) into n from public.stores where id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS after leaving, store no longer visible' || E'\n'; else bad := bad + 1; r := r || 'FAIL still sees store after leaving' || E'\n'; end if;

  raise exception 'TEST RESULTS (rolled back): % passed, % failed%', ok, bad, r;
end;
$test$;
