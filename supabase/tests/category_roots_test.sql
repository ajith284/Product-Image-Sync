-- google_drive_category_roots tests (Prompt 12). One DO block ending with RAISE EXCEPTION,
-- so everything is rolled back. Run after 20261001210000_drive_category_roots.sql.
do $test$
declare
  a uuid := gen_random_uuid();   -- owner, workspace A
  m uuid := gen_random_uuid();   -- member, workspace A
  b uuid := gen_random_uuid();   -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_b uuid; c_a uuid; n int; v text; flag boolean;
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.local'
  from unnest(array[a, m, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, m, 'member');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'BrandSure', 'cat-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'Other', 'cat-b.myshopify.com') returning id into s_b;
  insert into public.google_drive_connections (store_id, connection_status, google_account_id, root_folder_id, root_folder_name)
  values (s_a, 'connected', 'acct-1', null, null) returning id into c_a;
  insert into public.google_drive_connections (store_id, connection_status, google_account_id) values (s_b, 'connected', 'acct-b');

  -- ---------- schema / security ----------
  select relrowsecurity into flag from pg_class where oid = 'public.google_drive_category_roots'::regclass;
  if flag then ok := ok + 1; r := r || 'PASS RLS enabled on google_drive_category_roots' || E'\n';
  else bad := bad + 1; r := r || 'FAIL RLS off' || E'\n'; end if;
  if not has_table_privilege('authenticated', 'public.google_drive_category_roots', 'insert')
     and not has_table_privilege('authenticated', 'public.google_drive_category_roots', 'update')
     and not has_table_privilege('authenticated', 'public.google_drive_category_roots', 'delete')
     and not has_table_privilege('anon', 'public.google_drive_category_roots', 'select') then
    ok := ok + 1; r := r || 'PASS users cannot write category roots; anon cannot read' || E'\n';
  else bad := bad + 1; r := r || 'FAIL grants widened' || E'\n'; end if;
  select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                  and has_function_privilege('service_role', p.oid, 'execute'))
    into flag
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname in ('google_add_category_root', 'google_remove_category_root');
  if flag then ok := ok + 1; r := r || 'PASS add/remove functions: service_role only' || E'\n';
  else bad := bad + 1; r := r || 'FAIL functions executable by users' || E'\n'; end if;

  -- ---------- as the server ----------
  perform set_config('role', 'service_role', true);

  perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'sofaImageFolder1', 'Sofa image');
  perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'sofaBedImageFld1', 'Sofa bed image');
  perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'sofaImageFolder1', 'Sofa image');
  select count(*) into n from public.google_drive_category_roots where store_id = s_a;
  if n = 2 then ok := ok + 1; r := r || 'PASS multiple category roots per store; re-adding is idempotent' || E'\n';
  else bad := bad + 1; r := r || 'FAIL roots: ' || n || E'\n'; end if;

  select root_folder_id into v from public.google_drive_connections where id = c_a;
  if v = 'sofaImageFolder1' then ok := ok + 1; r := r || 'PASS single root_folder_id set to the first root (n8n / downloader compatible)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL root_folder_id: ' || coalesce(v, 'null') || E'\n'; end if;

  select count(*) into n from public.activity_logs where store_id = s_a and event_type = 'google_drive_category_root_added';
  if n = 3 then ok := ok + 1; r := r || 'PASS each add is logged in activity' || E'\n';
  else bad := bad + 1; r := r || 'FAIL activity: ' || n || E'\n'; end if;

  begin
    perform public.google_add_category_root(s_a, ws_a, m, 'acct-1', 'diningChairFld01', 'Dining chair image');
    bad := bad + 1; r := r || 'FAIL a member added a category root' || E'\n';
  exception when others then
    if sqlerrm = 'forbidden' then ok := ok + 1; r := r || 'PASS members cannot add category roots' || E'\n';
    else bad := bad + 1; r := r || 'FAIL member: ' || sqlerrm || E'\n'; end if; end;

  begin
    perform public.google_add_category_root(s_a, ws_b, b, 'acct-1', 'diningChairFld01', 'Dining chair image');
    bad := bad + 1; r := r || 'FAIL added a root to another workspace store' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS another workspace cannot add roots to this store' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross ws: ' || sqlerrm || E'\n'; end if; end;

  begin
    perform public.google_add_category_root(s_a, ws_a, a, 'acct-OTHER', 'diningChairFld01', 'Dining chair image');
    bad := bad + 1; r := r || 'FAIL root added with a different Google account' || E'\n';
  exception when others then
    if sqlerrm = 'google_not_connected' then ok := ok + 1; r := r || 'PASS a root must belong to the connected Google account' || E'\n';
    else bad := bad + 1; r := r || 'FAIL account: ' || sqlerrm || E'\n'; end if; end;

  begin
    perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'bad id!', 'X');
    bad := bad + 1; r := r || 'FAIL invalid folder id accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS invalid folder ids rejected' || E'\n'; end;

  update public.google_drive_connections set connection_status = 'needs_reconnect' where id = c_a;
  begin
    perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'diningChairFld01', 'Dining chair image');
    bad := bad + 1; r := r || 'FAIL root added while Google not connected' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS roots can only be added while Google is connected' || E'\n'; end;
  update public.google_drive_connections set connection_status = 'connected' where id = c_a;

  -- remove: reassigns root_folder_id, only configuration is deleted
  flag := public.google_remove_category_root(s_a, ws_a, a, 'sofaImageFolder1');
  select root_folder_id into v from public.google_drive_connections where id = c_a;
  if flag and v = 'sofaBedImageFld1' then ok := ok + 1; r := r || 'PASS removing the first root moves root_folder_id to the next root' || E'\n';
  else bad := bad + 1; r := r || 'FAIL remove: ' || coalesce(v, 'null') || E'\n'; end if;
  if not public.google_remove_category_root(s_a, ws_a, a, 'sofaImageFolder1') then
    ok := ok + 1; r := r || 'PASS removing an unknown root returns false' || E'\n';
  else bad := bad + 1; r := r || 'FAIL double remove' || E'\n'; end if;
  begin
    perform public.google_remove_category_root(s_a, ws_a, m, 'sofaBedImageFld1');
    bad := bad + 1; r := r || 'FAIL member removed a root' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS members cannot remove roots' || E'\n'; end;
  perform public.google_remove_category_root(s_a, ws_a, a, 'sofaBedImageFld1');
  select root_folder_id into v from public.google_drive_connections where id = c_a;
  if v is null then ok := ok + 1; r := r || 'PASS removing the last root clears root_folder_id (store not ready for sync)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL last remove: ' || v || E'\n'; end if;

  -- deleting the connection removes its roots (configuration), never stores
  perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'sofaImageFolder1', 'Sofa image');
  delete from public.google_drive_connections where id = c_a;
  select count(*) into n from public.google_drive_category_roots where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS roots go with their connection' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cascade: ' || n || E'\n'; end if;
  insert into public.google_drive_connections (store_id, connection_status, google_account_id) values (s_a, 'connected', 'acct-1') returning id into c_a;
  perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'sofaImageFolder1', 'Sofa image');

  -- ---------- signed-in users (RLS) ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  select count(*) into n from public.google_drive_category_roots where store_id = s_a;
  if n = 1 then ok := ok + 1; r := r || 'PASS workspace members can read their store''s category roots' || E'\n';
  else bad := bad + 1; r := r || 'FAIL member read: ' || n || E'\n'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.google_drive_category_roots where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS another workspace cannot see them' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cross-workspace read: ' || n || E'\n'; end if;
  begin
    perform public.google_add_category_root(s_a, ws_a, a, 'acct-1', 'diningChairFld01', 'X');
    bad := bad + 1; r := r || 'FAIL a signed-in user called the function' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot call the functions' || E'\n'; end;

  raise exception '%', r || E'\ncategory roots tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
