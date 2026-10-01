-- Google Drive OAuth database tests. One transaction, ends with RAISE EXCEPTION,
-- so everything is rolled back. Run with the Supabase MCP execute_sql tool.
do $test$
declare
  a uuid := gen_random_uuid();  -- owner, workspace A
  m uuid := gen_random_uuid();  -- member in A
  b uuid := gen_random_uuid();  -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_a2 uuid; s_b uuid; conn uuid; conn2 uuid; conn3 uuid;
  h1 text := repeat('1', 64); h2 text := repeat('2', 64); h3 text := repeat('3', 64); h4 text := repeat('4', 64);
  scopes text := 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.readonly';
  n int; u uuid; r text := E'\n'; ok int := 0; bad int := 0; rec record;
begin
  -- ---------- setup ----------
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.local'
  from unnest(array[a, m, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, m, 'member');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'A store', 'g-test-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name) values (ws_a, 'A second store') returning id into s_a2;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'B store', 'g-test-b.myshopify.com') returning id into s_b;

  -- ================= API roles cannot call service RPCs or read secrets =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin perform public.google_get_credentials(s_a);
    bad := bad + 1; r := r || 'FAIL authenticated executed google_get_credentials' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call google_get_credentials (42501)' || E'\n'; end;
  begin perform public.google_begin_oauth(a, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL authenticated executed google_begin_oauth' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call google_begin_oauth (42501)' || E'\n'; end;
  begin perform public.google_save_connection(s_a, ws_a, a, 'sub', 'x@y.z', scopes, 'v1.x', 'v1.y', null);
    bad := bad + 1; r := r || 'FAIL authenticated executed google_save_connection' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call google_save_connection (42501)' || E'\n'; end;
  begin perform count(*) from internal.integration_secrets;
    bad := bad + 1; r := r || 'FAIL authenticated read integration_secrets' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot read internal.integration_secrets (42501)' || E'\n'; end;
  begin perform count(*) from internal.oauth_states;
    bad := bad + 1; r := r || 'FAIL authenticated read oauth_states' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot read internal.oauth_states (42501)' || E'\n'; end;
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'google_drive_connections' and column_name ~ '(access|refresh)_token|secret';
  if n = 0 then ok := ok + 1; r := r || 'PASS google_drive_connections has no token/secret columns (tokens only in internal.integration_secrets)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL token column in google_drive_connections' || E'\n'; end if;
  begin perform connection_status, google_account_email, granted_scopes, last_error, disconnected_at from public.google_drive_connections;
    ok := ok + 1; r := r || 'PASS authenticated can read display columns (status, email, scopes, last_error)' || E'\n';
  exception when others then bad := bad + 1; r := r || 'FAIL display columns: ' || sqlerrm || E'\n'; end;
  begin insert into public.google_drive_connections (store_id, connection_status) values (s_a, 'connected');
    bad := bad + 1; r := r || 'FAIL authenticated inserted a Drive connection' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS users cannot write google_drive_connections directly' || E'\n'; end;
  perform set_config('role', 'anon', true);
  begin perform public.google_consume_oauth_state(h1);
    bad := bad + 1; r := r || 'FAIL anon consumed state' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot call google_consume_oauth_state (42501)' || E'\n'; end;

  -- From here on: the app server (service_role).
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ================= begin_oauth permission checks =================
  begin perform public.google_begin_oauth(m, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL member started Google OAuth' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot start Google OAuth (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member start: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_begin_oauth(b, s_a, h1, 600);
    bad := bad + 1; r := r || 'FAIL workspace B owner started OAuth for A store' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS other workspace cannot connect Drive to A store (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross-ws start: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_begin_oauth(a, gen_random_uuid(), h1, 600);
    bad := bad + 1; r := r || 'FAIL unknown store accepted' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS unknown store rejected' || E'\n';
    else bad := bad + 1; r := r || 'FAIL unknown store: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_begin_oauth(a, s_a, 'raw-state', 600);
    bad := bad + 1; r := r || 'FAIL non-hash state accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS only a SHA-256 state hash is accepted' || E'\n'; end;

  u := public.google_begin_oauth(a, s_a, h1, 600);
  select count(*) into n from internal.oauth_states
  where state_hash = h1 and provider = 'google_drive' and user_id = a and workspace_id = ws_a and store_id = s_a
    and shop_domain is null and used_at is null and expires_at <= now() + interval '10 minutes';
  if u = s_a and n = 1 then ok := ok + 1; r := r || 'PASS state stored in oauth_states: google_drive, hash, user, workspace, store, 10-min expiry' || E'\n';
  else bad := bad + 1; r := r || 'FAIL state row' || E'\n'; end if;

  -- ================= consume: one-time / unknown / expired / wrong provider =================
  select * into rec from public.google_consume_oauth_state(h1);
  if rec.status = 'ok' and rec.user_id = a and rec.workspace_id = ws_a and rec.store_id = s_a then ok := ok + 1; r := r || 'PASS valid state consumed' || E'\n';
  else bad := bad + 1; r := r || 'FAIL consume: ' || rec.status || E'\n'; end if;
  select * into rec from public.google_consume_oauth_state(h1);
  if rec.status = 'reused' and rec.user_id is null then ok := ok + 1; r := r || 'PASS reused state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL reuse: ' || rec.status || E'\n'; end if;
  select * into rec from public.google_consume_oauth_state(repeat('f', 64));
  if rec.status = 'unknown' then ok := ok + 1; r := r || 'PASS invalid (unknown) state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unknown: ' || rec.status || E'\n'; end if;
  insert into internal.oauth_states (provider, state_hash, user_id, workspace_id, store_id, expires_at)
  values ('google_drive', h2, a, ws_a, s_a, now() - interval '1 minute');
  select * into rec from public.google_consume_oauth_state(h2);
  if rec.status = 'expired' and rec.user_id is null then ok := ok + 1; r := r || 'PASS expired state rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL expired: ' || rec.status || E'\n'; end if;
  select * into rec from public.google_consume_oauth_state(h2);
  if rec.status = 'reused' then ok := ok + 1; r := r || 'PASS expired state cannot be retried' || E'\n';
  else bad := bad + 1; r := r || 'FAIL expired retry: ' || rec.status || E'\n'; end if;
  insert into internal.oauth_states (provider, state_hash, user_id, workspace_id, store_id, shop_domain, expires_at)
  values ('shopify', h3, a, ws_a, s_a, 'g-test-a.myshopify.com', now() + interval '10 minutes');
  select * into rec from public.google_consume_oauth_state(h3);
  select count(*) into n from internal.oauth_states where state_hash = h3 and used_at is null;
  if rec.status = 'unknown' and n = 1 then ok := ok + 1; r := r || 'PASS a Shopify state cannot be used for Google (and is left untouched)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cross-provider state: ' || rec.status || E'\n'; end if;

  -- ================= save connection =================
  begin perform public.google_save_connection(s_a, ws_a, a, 'sub-1', 'a@gmail.com', scopes, 'ya29.PLAINTEXT', null, null);
    bad := bad + 1; r := r || 'FAIL plaintext token accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS plaintext (non-encrypted) access token rejected' || E'\n'; end;
  begin perform public.google_save_connection(s_a, ws_a, a, 'sub-1', 'a@gmail.com', scopes, 'v1.a.b.c', '1//PLAINTEXT', null);
    bad := bad + 1; r := r || 'FAIL plaintext refresh token accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS plaintext refresh token rejected' || E'\n'; end;
  begin perform public.google_save_connection(s_a, ws_a, m, 'sub-1', 'a@gmail.com', scopes, 'v1.a.b.c', 'v1.d.e.f', null);
    bad := bad + 1; r := r || 'FAIL member saved connection' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot save a Drive connection (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member save: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_save_connection(s_a, ws_b, b, 'sub-1', 'a@gmail.com', scopes, 'v1.a.b.c', 'v1.d.e.f', null);
    bad := bad + 1; r := r || 'FAIL workspace B saved into A store' || E'\n';
  exception when others then
    if sqlerrm = 'store_mismatch' then ok := ok + 1; r := r || 'PASS cannot save a connection for another workspace store (store_mismatch)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross-ws save: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_save_connection(s_a, ws_a, a, 'sub-1', 'a@gmail.com', scopes, 'v1.a.b.c', null, null);
    bad := bad + 1; r := r || 'FAIL first connection without refresh token' || E'\n';
  exception when others then
    if sqlerrm = 'missing_refresh_token' then ok := ok + 1; r := r || 'PASS first connection requires a refresh token (background sync)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL missing refresh: ' || sqlerrm || E'\n'; end if; end;

  conn := public.google_save_connection(s_a, ws_a, a, 'sub-1', 'a@gmail.com', scopes,
    'v1.acc.one.tag', 'v1.ref.one.tag', now() + interval '1 hour');
  select count(*) into n from public.google_drive_connections c
  where c.id = conn and c.store_id = s_a and c.connection_status = 'pending' and c.google_account_id = 'sub-1'
    and c.google_account_email = 'a@gmail.com' and c.connected_by = a and c.connected_at is not null
    and c.granted_scopes = '["openid","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/drive.readonly"]'::jsonb;
  if n = 1 then ok := ok + 1; r := r || 'PASS connection saved (status pending, account, email, scopes, connected_by)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL connection row' || E'\n'; end if;
  select count(*) into n from internal.integration_secrets
  where connection_id = conn and provider = 'google_drive' and encrypted_access_token = 'v1.acc.one.tag'
    and encrypted_refresh_token = 'v1.ref.one.tag' and token_expires_at is not null and token_version = 1;
  if n = 1 then ok := ok + 1; r := r || 'PASS encrypted tokens + expiry stored in integration_secrets (provider google_drive)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL secrets row' || E'\n'; end if;
  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'google_drive_connected'
    and message = 'Connected Google Drive (a@gmail.com).' and metadata::text !~ 'v1\.';
  if n = 1 then ok := ok + 1; r := r || 'PASS activity logged without token data' || E'\n';
  else bad := bad + 1; r := r || 'FAIL activity' || E'\n'; end if;

  select * into rec from public.google_get_credentials(s_a);
  if rec.connection_id = conn and rec.encrypted_refresh_token = 'v1.ref.one.tag' and rec.token_version = 1 and not rec.account_shared then
    ok := ok + 1; r := r || 'PASS get_credentials returns encrypted values only (account not shared)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL get_credentials' || E'\n'; end if;

  -- verification
  perform public.google_record_verification(s_a, true, null, 'a@gmail.com', null, false);
  select count(*) into n from public.google_drive_connections where id = conn and connection_status = 'connected' and last_verified_at is not null;
  if n = 1 then ok := ok + 1; r := r || 'PASS verification sets connected + last_verified_at' || E'\n';
  else bad := bad + 1; r := r || 'FAIL verify' || E'\n'; end if;
  select count(*) into n from public.stores where id = s_a and status = 'setup';
  if n = 1 then ok := ok + 1; r := r || 'PASS Drive status does not change the store (Shopify) status' || E'\n';
  else bad := bad + 1; r := r || 'FAIL store status changed' || E'\n'; end if;

  -- refresh with optimistic lock
  if public.google_store_refreshed_tokens(conn, 1, 'v1.acc.two.tag', null, now() + interval '1 hour')
     and not public.google_store_refreshed_tokens(conn, 1, 'v1.acc.three.tag', null, now() + interval '1 hour') then
    ok := ok + 1; r := r || 'PASS refreshed token saved once; stale version rejected' || E'\n';
  else bad := bad + 1; r := r || 'FAIL refresh lock' || E'\n'; end if;
  select count(*) into n from internal.integration_secrets where connection_id = conn and encrypted_access_token = 'v1.acc.two.tag'
    and encrypted_refresh_token = 'v1.ref.one.tag' and token_version = 2;
  if n = 1 then ok := ok + 1; r := r || 'PASS refresh keeps the refresh token when Google returns none' || E'\n';
  else bad := bad + 1; r := r || 'FAIL refresh keep' || E'\n'; end if;

  -- reconnect: same account without new refresh token keeps the old one
  update public.google_drive_connections set root_folder_id = 'folder-1', root_folder_name = 'Sofa' where id = conn;
  perform public.google_save_connection(s_a, ws_a, a, 'sub-1', 'a@gmail.com', scopes, 'v1.acc.four.tag', null, now() + interval '1 hour');
  select count(*) into n from internal.integration_secrets s join public.google_drive_connections c on c.id = s.connection_id
  where c.id = conn and s.encrypted_refresh_token = 'v1.ref.one.tag' and c.root_folder_id = 'folder-1';
  if n = 1 then ok := ok + 1; r := r || 'PASS same-account reconnect keeps refresh token and root folder' || E'\n';
  else bad := bad + 1; r := r || 'FAIL same-account reconnect' || E'\n'; end if;
  -- different account: must bring a refresh token, folder is cleared
  begin perform public.google_save_connection(s_a, ws_a, a, 'sub-2', 'other@gmail.com', scopes, 'v1.x.y.z', null, null);
    bad := bad + 1; r := r || 'FAIL account switch without refresh token' || E'\n';
  exception when others then
    if sqlerrm = 'missing_refresh_token' then ok := ok + 1; r := r || 'PASS switching account requires a new refresh token' || E'\n';
    else bad := bad + 1; r := r || 'FAIL switch: ' || sqlerrm || E'\n'; end if; end;
  perform public.google_save_connection(s_a, ws_a, a, 'sub-2', 'other@gmail.com', scopes, 'v1.acc.five.tag', 'v1.ref.five.tag', now() + interval '1 hour');
  select count(*) into n from public.google_drive_connections where id = conn and google_account_id = 'sub-2'
    and google_account_email = 'other@gmail.com' and root_folder_id is null and root_folder_name is null;
  if n = 1 then ok := ok + 1; r := r || 'PASS switching Google account clears the old root folder' || E'\n';
  else bad := bad + 1; r := r || 'FAIL switch clears folder' || E'\n'; end if;

  -- shared account detection (same Google account on another store)
  conn2 := public.google_save_connection(s_a2, ws_a, a, 'sub-2', 'other@gmail.com', scopes, 'v1.acc.six.tag', 'v1.ref.six.tag', now() + interval '1 hour');
  select * into rec from public.google_get_credentials(s_a);
  if rec.account_shared then ok := ok + 1; r := r || 'PASS account_shared = true when another store uses the same Google account' || E'\n';
  else bad := bad + 1; r := r || 'FAIL account_shared' || E'\n'; end if;

  -- ================= disconnect =================
  begin perform public.google_disconnect(s_a, m);
    bad := bad + 1; r := r || 'FAIL member disconnected' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS member cannot disconnect (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member disconnect: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_disconnect(s_a, b);
    bad := bad + 1; r := r || 'FAIL other workspace disconnected' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS other workspace cannot disconnect (forbidden)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross-ws disconnect: ' || sqlerrm || E'\n'; end if; end;
  if public.google_disconnect(s_a2, a) and not public.google_disconnect(s_a2, a) then
    ok := ok + 1; r := r || 'PASS disconnect works and is idempotent' || E'\n';
  else bad := bad + 1; r := r || 'FAIL disconnect' || E'\n'; end if;
  select count(*) into n from internal.integration_secrets where connection_id = conn2;
  if n = 0 then ok := ok + 1; r := r || 'PASS disconnect deletes the encrypted tokens' || E'\n';
  else bad := bad + 1; r := r || 'FAIL secrets remain' || E'\n'; end if;
  select count(*) into n from public.google_get_credentials(s_a2);
  if n = 0 then ok := ok + 1; r := r || 'PASS no credentials after disconnect' || E'\n';
  else bad := bad + 1; r := r || 'FAIL creds after disconnect' || E'\n'; end if;
  select * into rec from public.google_get_credentials(s_a);
  if not rec.account_shared then ok := ok + 1; r := r || 'PASS account no longer shared after the other store disconnects' || E'\n';
  else bad := bad + 1; r := r || 'FAIL shared after disconnect' || E'\n'; end if;

  -- workspace B can use its own store independently
  u := public.google_begin_oauth(b, s_b, h4, 600);
  conn3 := public.google_save_connection(s_b, ws_b, b, 'sub-b', 'b@gmail.com', scopes, 'v1.b.acc.tag', 'v1.b.ref.tag', now() + interval '1 hour');
  if u = s_b and conn3 is not null then ok := ok + 1; r := r || 'PASS workspace B connects its own store' || E'\n';
  else bad := bad + 1; r := r || 'FAIL workspace B' || E'\n'; end if;

  -- ================= RLS: members see only their workspace's Drive rows =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  select count(*) into n from public.google_drive_connections where store_id in (s_a, s_a2, s_b);
  if n = 2 then ok := ok + 1; r := r || 'PASS member of A sees A''s Drive rows only (not B''s)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL RLS count ' || n || E'\n'; end if;
  perform set_config('role', 'service_role', true);

  raise exception 'GOOGLE DRIVE DB TESTS (rolled back): % passed, % failed%', ok, bad, r;
end;
$test$;
