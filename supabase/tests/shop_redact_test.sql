-- shop/redact tests (Prompt 14F). One DO block ending with RAISE EXCEPTION → rolled back.
do $test$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  ws_a uuid; ws_b uuid; s_a uuid; s_a2 uuid; s_b uuid; c_a uuid; c_b uuid; job uuid; item uuid;
  shop text := 'redact-' || left(gen_random_uuid()::text, 8) || '.myshopify.com';
  other_shop text := 'keep-' || left(gen_random_uuid()::text, 8) || '.myshopify.com';
  v text; n int; flag boolean;
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@redact.local'
  from unnest(array[a, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Redacted store', shop) returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Other store same ws', other_shop) returning id into s_a2;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'Other ws', 'other-' || left(gen_random_uuid()::text, 8) || '.myshopify.com') returning id into s_b;
  insert into public.shopify_connections (store_id, shop_domain, connection_status) values (s_a, shop, 'connected') returning id into c_a;
  insert into public.shopify_connections (store_id, shop_domain, connection_status) values (s_a2, other_shop, 'connected') returning id into c_b;
  insert into internal.integration_secrets (provider, connection_id, encrypted_access_token)
  select 'shopify', c.id, 'v1.fake' from public.shopify_connections c where c.id in (c_a, c_b);
  insert into public.google_drive_connections (store_id, connection_status, root_folder_id, root_folder_name) values (s_a, 'connected', 'sofaFolderId001', 'Sofa');
  insert into public.product_mappings (store_id, drive_folder_id, drive_folder_name, shopify_product_id, shopify_product_title)
  values (s_a, 'prodMilanoxxxxx', 'Milano', 'gid://shopify/Product/1', 'Milano Sofa'),
         (s_a2, 'prodRomaxxxxxxx', 'Roma', 'gid://shopify/Product/9', 'Roma Sofa');
  insert into public.sync_jobs (store_id, workspace_id, status, trigger_type, dry_run, items_total, result)
  values (s_a, ws_a, 'completed', 'n8n', false, 1, '{"products":1,"review_items":[{"candidates":[{"title":"Milano Sofa"}]}],"uploaded":3}')
  returning id into job;
  insert into public.sync_items (sync_job_id, store_id, drive_folder_id, drive_folder_name, shopify_product_id, shopify_product_title, product_status, status, match_candidates)
  values (job, s_a, 'prodMilanoxxxxx', 'Milano', 'gid://shopify/Product/1', 'Milano Sofa', 'ACTIVE', 'synced', '[{"id":"gid://shopify/Product/1","title":"Milano Sofa"}]')
  returning id into item;
  insert into public.sync_images (store_id, sync_item_id, shopify_product_id, drive_file_id, filename, upload_status, shopify_media_id)
  values (s_a, item, 'gid://shopify/Product/1', 'milano1jpgxxxxx', '1.jpg', 'uploaded', 'gid://shopify/MediaImage/5');

  -- ---------- grants ----------
  select not has_function_privilege('authenticated', 'public.shopify_handle_shop_redact(text, text)', 'execute')
     and not has_function_privilege('anon', 'public.shopify_handle_shop_redact(text, text)', 'execute')
     and has_function_privilege('service_role', 'public.shopify_handle_shop_redact(text, text)', 'execute') into flag;
  if flag then ok := ok + 1; r := r || 'PASS shopify_handle_shop_redact: service_role only' || E'\n';
  else bad := bad + 1; r := r || 'FAIL redact grants' || E'\n'; end if;

  perform set_config('role', 'service_role', true);

  -- ---------- still connected (reinstalled) → nothing erased ----------
  v := public.shopify_handle_shop_redact('wh-redact-0', shop);
  select count(*) into n from public.product_mappings where store_id = s_a;
  if v = 'skipped_connected' and n = 1 then ok := ok + 1; r := r || 'PASS a shop that is connected again is NOT erased (skipped_connected)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL connected shop: ' || v || ' mappings=' || n || E'\n'; end if;

  -- ---------- uninstall, then redact ----------
  perform public.shopify_handle_app_uninstalled('wh-uninstall-1', shop);
  v := public.shopify_handle_shop_redact('wh-redact-1', shop);
  if v = 'redacted' then ok := ok + 1; r := r || 'PASS after uninstall, shop/redact → redacted' || E'\n';
  else bad := bad + 1; r := r || 'FAIL redact result: ' || v || E'\n'; end if;

  select count(*) into n from public.shopify_connections where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS Shopify connection row deleted' || E'\n';
  else bad := bad + 1; r := r || 'FAIL connection kept' || E'\n'; end if;
  select count(*) into n from internal.integration_secrets where provider = 'shopify' and connection_id = c_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS Shopify secrets deleted' || E'\n';
  else bad := bad + 1; r := r || 'FAIL secrets kept' || E'\n'; end if;
  select (select count(*) from public.product_mappings where store_id = s_a) + (select count(*) from public.sync_images where store_id = s_a) into n;
  if n = 0 then ok := ok + 1; r := r || 'PASS product mappings and the Shopify media ledger deleted' || E'\n';
  else bad := bad + 1; r := r || 'FAIL mappings/images kept: ' || n || E'\n'; end if;
  select coalesce(shopify_product_id, '') || coalesce(shopify_product_title, '') || coalesce(product_status, '') || match_candidates::text into v
  from public.sync_items where id = item;
  if v = '[]' then ok := ok + 1; r := r || 'PASS sync_items Shopify fields anonymized (Drive folder names kept)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL sync_items: ' || v || E'\n'; end if;
  select result::text into v from public.sync_jobs where id = job;
  if v not like '%review_items%' and v like '%"uploaded": 3%' then ok := ok + 1; r := r || 'PASS job result loses Shopify candidates, keeps counts' || E'\n';
  else bad := bad + 1; r := r || 'FAIL job result: ' || v || E'\n'; end if;

  -- kept: the merchant's own store, Google connection, job history, other stores
  select (select count(*) from public.stores where id = s_a) + (select count(*) from public.google_drive_connections where store_id = s_a)
       + (select count(*) from public.sync_jobs where id = job) into n;
  if n = 3 then ok := ok + 1; r := r || 'PASS the Product Image Sync store, its Google connection and job history are kept' || E'\n';
  else bad := bad + 1; r := r || 'FAIL kept data: ' || n || E'\n'; end if;
  select (select count(*) from public.product_mappings where store_id = s_a2) + (select count(*) from public.shopify_connections where id = c_b)
       + (select count(*) from internal.integration_secrets where connection_id = c_b) into n;
  if n = 3 then ok := ok + 1; r := r || 'PASS another shop in the same workspace is untouched' || E'\n';
  else bad := bad + 1; r := r || 'FAIL other shop touched: ' || n || E'\n'; end if;
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'shopify_shop_redacted';
  if n = 1 then ok := ok + 1; r := r || 'PASS one activity entry records the erasure' || E'\n';
  else bad := bad + 1; r := r || 'FAIL activity: ' || n || E'\n'; end if;

  -- ---------- idempotency ----------
  v := public.shopify_handle_shop_redact('wh-redact-1', shop);
  if v = 'duplicate' then ok := ok + 1; r := r || 'PASS same webhook id again → duplicate' || E'\n';
  else bad := bad + 1; r := r || 'FAIL duplicate: ' || v || E'\n'; end if;
  v := public.shopify_handle_shop_redact('wh-redact-2', shop);
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'shopify_shop_redacted';
  if v = 'nothing_to_redact' and n = 1 then ok := ok + 1; r := r || 'PASS a second redact for the same shop finds nothing left (no new activity entry)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL second redact: ' || v || E'\n'; end if;
  v := public.shopify_handle_shop_redact('wh-redact-3', 'never-installed.myshopify.com');
  if v = 'nothing_to_redact' then ok := ok + 1; r := r || 'PASS unknown shop → nothing_to_redact' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unknown shop: ' || v || E'\n'; end if;
  begin perform public.shopify_handle_shop_redact('wh-redact-4', 'evil.com');
    bad := bad + 1; r := r || 'FAIL invalid domain accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS invalid shop domain rejected' || E'\n'; end;

  raise exception '%', r || E'\nshop redact tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
