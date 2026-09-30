-- Shopify OAuth database tests. One transaction, ends with RAISE EXCEPTION,
-- so everything is rolled back. Run with the Supabase MCP execute_sql tool.
do $test$
declare
  a uuid := gen_random_uuid();  -- owner, workspace A
  m uuid := gen_random_uuid();  -- member in A
  b uuid := gen_random_uuid();  -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_b uuid; s_nodomain uuid; conn uuid; conn2 uuid;
  shop text := 'test-oauth-shop.myshopify.com';
  h1 text := repeat('a', 64); h2 text := repeat('b', 64); h3 text := repeat('c', 64); h4 text := repeat('d', 64);
  n int; t text; ok_ boolean; r text := E'\n'; ok int := 0; bad int := 0;
  rec record; logs_before int; jobs_before int; maps_before int;
begin
  -- ---------- setup ----------
  insert into auth.users (id, instance_id, aud, role, email)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u::text || '@test.local'
  from unnest(array[a, m, b]) u;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, m, 'member');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'A store', shop) returning id into s_a;
  insert into public.stores (workspace_id, name) values (ws_a, 'No domain') returning id into s_nodomain;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'B store', shop) returning id into s_b;

  -- ================= API roles cannot call service RPCs =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin perform public.shopify_get_credentials(s_a);
    bad := bad + 1; r := r || 'FAIL authenticated executed shopify_get_credentials' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call shopify_get_credentials (42501)' || E'\n'; end;
  begin perform public.shopify_begin_oauth(a, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL authenticated executed shopify_begin_oauth' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call shopify_begin_oauth (42501)' || E'\n'; end;
  begin perform public.shopify_save_connection(s_a, ws_a, a, shop, 'x', 'v1.x', null, null, null);
    bad := bad + 1; r := r || 'FAIL authenticated executed shopify_save_connection' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call shopify_save_connection (42501)' || E'\n'; end;
  begin perform count(*) from internal.webhook_events;
    bad := bad + 1; r := r || 'FAIL authenticated read webhook_events' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot read webhook_events (42501)' || E'\n'; end;
  perform set_config('role', 'anon', true);
  begin perform public.shopify_handle_app_uninstalled('x', shop);
    bad := bad + 1; r := r || 'FAIL anon executed uninstall handler' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot call webhook RPCs (42501)' || E'\n'; end;

  -- From here on: the app server (service_role).
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ================= begin_oauth permission checks =================
  begin perform public.shopify_begin_oauth(m, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL member started OAuth' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot start OAuth (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member start: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.shopify_begin_oauth(b, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL other-workspace owner started OAuth for A' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS other workspace cannot start OAuth for A store (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross-ws start: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.shopify_begin_oauth(a, s_nodomain, h1, 600);
    bad := bad + 1; r := r || 'FAIL OAuth without domain' || E'\n';
  exception when others then
    if sqlerrm = 'invalid_shop_domain' then ok := ok + 1; r := r || 'PASS store without Shopify domain rejected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL nodomain: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.shopify_begin_oauth(a, s_a, 'plain-state-not-a-hash', 600);
    bad := bad + 1; r := r || 'FAIL non-hash state accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS only a SHA-256 state hash is accepted' || E'\n'; end;

  t := public.shopify_begin_oauth(a, s_a, h1, 600);
  if t = shop then ok := ok + 1; r := r || 'PASS owner starts OAuth; state stored with user/workspace/store' || E'\n';
  else bad := bad + 1; r := r || 'FAIL begin returned ' || coalesce(t, 'null') || E'\n'; end if;
  select count(*) into n from internal.oauth_states where state_hash = h1 and user_id = a and workspace_id = ws_a and store_id = s_a and expires_at <= now() + interval '10 minutes' and used_at is null;
  if n = 1 then ok := ok + 1; r := r || 'PASS state row: hash only, 10-minute expiry, unused' || E'\n';
  else bad := bad + 1; r := r || 'FAIL state row check' || E'\n'; end if;

  -- ================= consume: one-time / unknown / expired =================
  select * into rec from public.shopify_consume_oauth_state(h1);
  if rec.status = 'ok' and rec.user_id = a and rec.store_id = s_a and rec.shop_domain = shop then ok := ok + 1; r := r || 'PASS valid state consumed once' || E'\n';
  else bad := bad + 1; r := r || 'FAIL consume ok: ' || rec.status || E'\n'; end if;
  select * into rec from public.shopify_consume_oauth_state(h1);
  if rec.status = 'reused' and rec.user_id is null then ok := ok + 1; r := r || 'PASS reused state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL reuse: ' || rec.status || E'\n'; end if;
  select * into rec from public.shopify_consume_oauth_state(repeat('f', 64));
  if rec.status = 'unknown' then ok := ok + 1; r := r || 'PASS unknown state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unknown: ' || rec.status || E'\n'; end if;
  insert into internal.oauth_states (provider, state_hash, user_id, workspace_id, store_id, shop_domain, expires_at)
  values ('shopify', h2, a, ws_a, s_a, shop, now() - interval '1 minute');
  select * into rec from public.shopify_consume_oauth_state(h2);
  if rec.status = 'expired' and rec.user_id is null then ok := ok + 1; r := r || 'PASS expired state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL expired: ' || rec.status || E'\n'; end if;
  select * into rec from public.shopify_consume_oauth_state(h2);
  if rec.status = 'reused' then ok := ok + 1; r := r || 'PASS expired state cannot be retried later' || E'\n';
  else bad := bad + 1; r := r || 'FAIL expired retry: ' || rec.status || E'\n'; end if;

  -- ================= save connection =================
  begin perform public.shopify_save_connection(s_a, ws_a, a, shop, 'read_products', 'shpat_PLAINTEXT', null, null, null);
    bad := bad + 1; r := r || 'FAIL plaintext token accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS plaintext (non-encrypted) tokens rejected' || E'\n'; end;
  begin perform public.shopify_save_connection(s_a, ws_a, m, shop, 'x', 'v1.a.b.c', null, null, null);
    bad := bad + 1; r := r || 'FAIL member saved connection' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot save a connection (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member save: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.shopify_save_connection(s_a, ws_b, a, shop, 'x', 'v1.a.b.c', null, null, null);
    bad := bad + 1; r := r || 'FAIL workspace mismatch accepted' || E'\n';
  exception when others then
    if sqlerrm = 'store_mismatch' then ok := ok + 1; r := r || 'PASS store/workspace mismatch rejected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL mismatch: ' || sqlerrm || E'\n'; end if; end;

  conn := public.shopify_save_connection(s_a, ws_a, a, shop, 'read_products,write_products,write_files',
    'v1.iv.cipher.tag', 'v1.iv2.cipher2.tag2', now() + interval '1 hour', now() + interval '90 days');
  select count(*) into n from public.shopify_connections c
  where c.id = conn and c.store_id = s_a and c.connection_status = 'pending' and c.shop_domain = shop and c.connected_by = a
    and c.granted_scopes = '["read_products","write_products","write_files"]'::jsonb and c.installed_at is not null
    and c.refresh_token_expires_at > now() + interval '89 days';
  if n = 1 then ok := ok + 1; r := r || 'PASS connection saved with scopes, expiries, installer' || E'\n';
  else bad := bad + 1; r := r || 'FAIL connection row' || E'\n'; end if;
  select count(*) into n from internal.integration_secrets where connection_id = conn and provider = 'shopify'
    and encrypted_access_token = 'v1.iv.cipher.tag' and encrypted_refresh_token = 'v1.iv2.cipher2.tag2' and token_version = 1;
  if n = 1 then ok := ok + 1; r := r || 'PASS encrypted tokens stored in internal.integration_secrets' || E'\n';
  else bad := bad + 1; r := r || 'FAIL secrets row' || E'\n'; end if;
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'shopify_connected' and message not like '%v1.%';
  if n = 1 then ok := ok + 1; r := r || 'PASS activity logged without token values' || E'\n';
  else bad := bad + 1; r := r || 'FAIL connect activity' || E'\n'; end if;

  -- credentials read (server) + verification
  select * into rec from public.shopify_get_credentials(s_a);
  if rec.connection_id = conn and rec.encrypted_access_token = 'v1.iv.cipher.tag' and rec.token_version = 1 then ok := ok + 1; r := r || 'PASS server reads encrypted credentials' || E'\n';
  else bad := bad + 1; r := r || 'FAIL get_credentials' || E'\n'; end if;
  perform public.shopify_record_verification(s_a, true, null, 'gid://shopify/Shop/1', null, false);
  select count(*) into n from public.shopify_connections c join public.stores s on s.id = c.store_id
  where c.id = conn and c.connection_status = 'connected' and c.last_verified_at is not null and c.shopify_shop_id = 'gid://shopify/Shop/1' and s.status = 'connected';
  if n = 1 then ok := ok + 1; r := r || 'PASS verification marks connection + store connected, sets last_verified_at' || E'\n';
  else bad := bad + 1; r := r || 'FAIL verification' || E'\n'; end if;

  -- refresh optimistic locking
  ok_ := public.shopify_store_refreshed_tokens(conn, 1, 'v1.new.access.tag', 'v1.new.refresh.tag', now() + interval '1 hour', now() + interval '90 days');
  if ok_ then ok := ok + 1; r := r || 'PASS refreshed tokens stored (version 1 → 2)' || E'\n'; else bad := bad + 1; r := r || 'FAIL refresh store' || E'\n'; end if;
  ok_ := public.shopify_store_refreshed_tokens(conn, 1, 'v1.stale.access.tag', null, now(), null);
  select encrypted_access_token into t from internal.integration_secrets where connection_id = conn;
  if not ok_ and t = 'v1.new.access.tag' then ok := ok + 1; r := r || 'PASS stale refresh (lost race) does not overwrite' || E'\n';
  else bad := bad + 1; r := r || 'FAIL stale refresh' || E'\n'; end if;

  -- ================= workspace isolation (API view) =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into n from public.shopify_connections where id = conn;
  if n = 1 then ok := ok + 1; r := r || 'PASS owner A sees own connection metadata' || E'\n'; else bad := bad + 1; r := r || 'FAIL A sees connection' || E'\n'; end if;
  begin update public.shopify_connections set connection_status = 'connected', last_error = null where id = conn;
    bad := bad + 1; r := r || 'FAIL user updated connection' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS users cannot modify connection metadata (42501)' || E'\n'; end;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.shopify_connections where id = conn or store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS workspace B cannot see A''s Shopify connection' || E'\n'; else bad := bad + 1; r := r || 'FAIL B sees A connection' || E'\n'; end if;
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ================= unique active shop across workspaces =================
  begin perform public.shopify_begin_oauth(b, s_b, h3, 600);
    bad := bad + 1; r := r || 'FAIL B started OAuth for a shop active in A' || E'\n';
  exception when others then
    if sqlerrm = 'shop_connected_elsewhere' then ok := ok + 1; r := r || 'PASS OAuth blocked for a shop active in another workspace' || E'\n';
    else bad := bad + 1; r := r || 'FAIL unique begin: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.shopify_save_connection(s_b, ws_b, b, shop, 'x', 'v1.a.b.c', null, null, null);
    bad := bad + 1; r := r || 'FAIL second active connection saved' || E'\n';
  exception when others then
    if sqlerrm = 'shop_connected_elsewhere' then ok := ok + 1; r := r || 'PASS unique index blocks a second active connection' || E'\n';
    else bad := bad + 1; r := r || 'FAIL unique save: ' || sqlerrm || E'\n'; end if; end;

  -- ================= reconnect reuses the same row =================
  conn2 := public.shopify_save_connection(s_a, ws_a, a, shop, 'read_products,write_products,write_files',
    'v1.re.access.tag', 'v1.re.refresh.tag', now() + interval '1 hour', now() + interval '90 days');
  select count(*) into n from public.shopify_connections where store_id = s_a;
  select token_version into t from internal.integration_secrets where connection_id = conn;
  if conn2 = conn and n = 1 and t = '3' then ok := ok + 1; r := r || 'PASS reconnect updates the existing connection + replaces credentials' || E'\n';
  else bad := bad + 1; r := r || 'FAIL reconnect (rows=' || n || ', version=' || t || ')' || E'\n'; end if;
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'shopify_reconnected';
  if n = 1 then ok := ok + 1; r := r || 'PASS reconnect logged' || E'\n'; else bad := bad + 1; r := r || 'FAIL reconnect log' || E'\n'; end if;

  -- ================= disconnect preserves history =================
  insert into public.sync_jobs (store_id, status) values (s_a, 'completed');
  insert into public.product_mappings (store_id, drive_folder_id, shopify_product_id, mapping_type, created_by) values (s_a, 'f1', 'gid://shopify/Product/1', 'manual', a);
  select count(*) into logs_before from public.activity_logs where store_id = s_a;
  select count(*) into jobs_before from public.sync_jobs where store_id = s_a;
  select count(*) into maps_before from public.product_mappings where store_id = s_a;

  begin perform public.shopify_disconnect(s_a, m);
    bad := bad + 1; r := r || 'FAIL member disconnected' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot disconnect (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member disconnect: ' || sqlerrm || E'\n'; end if; end;

  ok_ := public.shopify_disconnect(s_a, a);
  select count(*) into n from internal.integration_secrets where connection_id = conn;
  if ok_ and n = 0 then ok := ok + 1; r := r || 'PASS disconnect deletes stored credentials' || E'\n'; else bad := bad + 1; r := r || 'FAIL disconnect secrets' || E'\n'; end if;
  select count(*) into n from public.shopify_connections c join public.stores s on s.id = c.store_id
  where c.id = conn and c.connection_status = 'disconnected' and c.disconnected_at is not null and c.token_expires_at is null and s.status = 'disconnected';
  if n = 1 then ok := ok + 1; r := r || 'PASS connection + store marked disconnected (row kept for history)' || E'\n'; else bad := bad + 1; r := r || 'FAIL disconnect status' || E'\n'; end if;
  select (select count(*) from public.sync_jobs where store_id = s_a) - jobs_before
       + (select count(*) from public.product_mappings where store_id = s_a) - maps_before
       + (select count(*) from public.activity_logs where store_id = s_a) - (logs_before + 1) into n;
  if n = 0 then ok := ok + 1; r := r || 'PASS sync history, mappings and activity preserved (+1 disconnect log)' || E'\n'; else bad := bad + 1; r := r || 'FAIL history changed by ' || n || E'\n'; end if;
  ok_ := public.shopify_disconnect(s_a, a);
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'shopify_disconnected';
  if not ok_ and n = 1 then ok := ok + 1; r := r || 'PASS second disconnect is a no-op (idempotent)' || E'\n'; else bad := bad + 1; r := r || 'FAIL repeat disconnect' || E'\n'; end if;
  select count(*) into n from public.shopify_get_credentials(s_a);
  if n = 0 then ok := ok + 1; r := r || 'PASS no credentials returned after disconnect' || E'\n'; else bad := bad + 1; r := r || 'FAIL creds after disconnect' || E'\n'; end if;

  -- Freed shop can now be connected by workspace B.
  t := public.shopify_begin_oauth(b, s_b, h3, 600);
  if t = shop then ok := ok + 1; r := r || 'PASS disconnected shop can be connected elsewhere' || E'\n'; else bad := bad + 1; r := r || 'FAIL freed shop' || E'\n'; end if;

  -- ================= app/uninstalled webhook (idempotent) =================
  conn2 := public.shopify_save_connection(s_b, ws_b, b, shop, 'read_products,write_products,write_files', 'v1.b.access.tag', 'v1.b.refresh.tag', now() + interval '1 hour', now() + interval '90 days');
  t := public.shopify_handle_app_uninstalled('wh-001', shop);
  select count(*) into n from internal.integration_secrets where connection_id = conn2;
  if t = 'disconnected' and n = 0 then ok := ok + 1; r := r || 'PASS uninstall webhook removes credentials + disconnects' || E'\n'; else bad := bad + 1; r := r || 'FAIL uninstall: ' || t || E'\n'; end if;
  select count(*) into n from public.activity_logs where store_id = s_b and event_type = 'shopify_uninstalled' and message = 'Shopify connection removed.';
  if n = 1 then ok := ok + 1; r := r || 'PASS uninstall logged "Shopify connection removed."' || E'\n'; else bad := bad + 1; r := r || 'FAIL uninstall log' || E'\n'; end if;
  t := public.shopify_handle_app_uninstalled('wh-001', shop);
  if t = 'duplicate' then ok := ok + 1; r := r || 'PASS duplicate delivery (same webhook id) ignored' || E'\n'; else bad := bad + 1; r := r || 'FAIL dup: ' || t || E'\n'; end if;
  t := public.shopify_handle_app_uninstalled('wh-002', shop);
  select count(*) into n from public.activity_logs where store_id = s_b and event_type = 'shopify_uninstalled';
  if t = 'no_active_connection' and n = 1 then ok := ok + 1; r := r || 'PASS repeat uninstall (new id) causes no duplicate changes' || E'\n'; else bad := bad + 1; r := r || 'FAIL repeat uninstall' || E'\n'; end if;
  ok_ := public.shopify_record_webhook('wh-003', 'shop/redact', shop);
  if ok_ and not public.shopify_record_webhook('wh-003', 'shop/redact', shop) then ok := ok + 1; r := r || 'PASS compliance webhooks recorded once' || E'\n'; else bad := bad + 1; r := r || 'FAIL compliance dedupe' || E'\n'; end if;

  raise exception 'SHOPIFY DB TESTS (rolled back): % passed, % failed%', ok, bad, r;
end;
$test$;
