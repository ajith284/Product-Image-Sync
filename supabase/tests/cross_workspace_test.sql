-- Cross-workspace isolation for newer tables / columns (Prompt 14B):
--   google_drive_category_roots, sync_errors, and the Prompt 13 sync_items fields
--   (category_root_id, code_folder_id, code_folder_name, match_candidates, images_skipped, images_failed).
-- One DO block ending with RAISE EXCEPTION → everything is rolled back.
do $test$
declare
  a uuid := gen_random_uuid();   -- owner, workspace A
  m uuid := gen_random_uuid();   -- member, workspace A
  b uuid := gen_random_uuid();   -- owner, workspace B
  x uuid := gen_random_uuid();   -- signed-in user with no workspace membership in A or B
  ws_a uuid; ws_b uuid; s_a uuid; s_b uuid; job_a uuid; job_b uuid; item_a uuid; item_b uuid; err_a uuid;
  n int; v text;
  r text := E'\n'; ok int := 0; bad int := 0;
begin
  insert into auth.users (id, instance_id, aud, role, email)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u::text || '@xws.local'
  from unnest(array[a, m, b, x]) u;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  delete from public.workspace_members where user_id = x;  -- x belongs to nothing
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_a, m, 'member');
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'A store', 'xws-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'B store', 'xws-b.myshopify.com') returning id into s_b;
  insert into public.google_drive_connections (store_id, connection_status, google_account_id) values
    (s_a, 'connected', 'acct-a'), (s_b, 'connected', 'acct-b');

  -- ---------- data in both workspaces, written as the server ----------
  perform set_config('role', 'service_role', true);
  perform public.google_add_category_root(s_a, ws_a, a, 'acct-a', 'sofaRootFolderA1', 'Sofa image A');
  perform public.google_add_category_root(s_b, ws_b, b, 'acct-b', 'sofaRootFolderB1', 'Sofa image B');

  insert into public.sync_jobs (store_id, workspace_id, status, trigger_type, dry_run) values (s_a, ws_a, 'queued', 'api', false) returning id into job_a;
  insert into public.sync_jobs (store_id, workspace_id, status, trigger_type, dry_run) values (s_b, ws_b, 'queued', 'api', false) returning id into job_b;
  perform public.sync_job_claim(ws_a, job_a, 'worker-xws-aaaa', 900);
  perform public.sync_job_claim(ws_b, job_b, 'worker-xws-bbbb', 900);
  item_a := public.sync_item_record(ws_a, job_a, 'worker-xws-aaaa', jsonb_build_object(
    'drive_folder_id', 'prodMilanoA0001', 'drive_folder_name', 'Milano', 'category_root_id', 'sofaRootFolderA1',
    'code_folder_id', 'codeSofA001xxxx', 'code_folder_name', 'SOF-A-001', 'status', 'multiple_matches', 'images_found', 3,
    'match_candidates', '[{"id":"gid://shopify/Product/11","title":"Milano","status":"ACTIVE"},{"id":"gid://shopify/Product/12","title":"Milano 2","status":"ACTIVE"}]'::jsonb));
  item_b := public.sync_item_record(ws_b, job_b, 'worker-xws-bbbb', jsonb_build_object(
    'drive_folder_id', 'prodRomaB000001', 'drive_folder_name', 'Roma', 'category_root_id', 'sofaRootFolderB1',
    'code_folder_id', 'codeSofB001xxxx', 'code_folder_name', 'SOF-B-001', 'status', 'matched', 'images_found', 2,
    'shopify_product_id', 'gid://shopify/Product/21', 'match_candidates', '[{"id":"gid://shopify/Product/21","title":"Roma","status":"ACTIVE"}]'::jsonb));
  perform public.sync_item_update(ws_a, job_a, 'worker-xws-aaaa', item_a, 'upload_failed', 1, 1, 1, 'one failed');
  perform public.sync_item_update(ws_b, job_b, 'worker-xws-bbbb', item_b, 'synced', 2, 0, 0, null);
  perform set_config('role', 'postgres', true);
  insert into public.sync_errors (sync_job_id, sync_item_id, store_id, error_type, message)
  values (job_a, item_a, s_a, 'upload_failed', 'A secret-ish error detail') returning id into err_a;
  insert into public.sync_errors (sync_job_id, sync_item_id, store_id, error_type, message)
  values (job_b, item_b, s_b, 'upload_failed', 'B error');

  -- ---------- server-side RPCs can't cross workspaces ----------
  perform set_config('role', 'service_role', true);
  begin perform public.sync_item_record(ws_b, job_a, 'worker-xws-aaaa', jsonb_build_object('drive_folder_id', 'x', 'status', 'matched'));
    bad := bad + 1; r := r || 'FAIL sync_item_record wrote into another workspace''s job' || E'\n';
  exception when others then
    if sqlerrm = 'job_not_found' then ok := ok + 1; r := r || 'PASS sync_item_record: workspace B cannot write items into job A' || E'\n';
    else bad := bad + 1; r := r || 'FAIL record cross ws: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.sync_item_update(ws_b, job_b, 'worker-xws-bbbb', item_a, 'synced', 9, 9, 9, null);
    bad := bad + 1; r := r || 'FAIL sync_item_update changed another job''s item' || E'\n';
  exception when others then
    if sqlerrm = 'item_not_found' then ok := ok + 1; r := r || 'PASS sync_item_update: job B''s worker cannot update an item of job A' || E'\n';
    else bad := bad + 1; r := r || 'FAIL update cross job: ' || sqlerrm || E'\n'; end if; end;
  begin perform public.google_remove_category_root(s_a, ws_b, b, 'sofaRootFolderA1');
    bad := bad + 1; r := r || 'FAIL workspace B removed A''s category root' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS workspace B cannot remove A''s category root (store_not_found)' || E'\n';
    else bad := bad + 1; r := r || 'FAIL remove cross ws: ' || sqlerrm || E'\n'; end if; end;
  select images_uploaded || '/' || images_skipped || '/' || images_failed into v from public.sync_items where id = item_a;
  if v = '1/1/1' then ok := ok + 1; r := r || 'PASS item A unchanged by the cross-workspace attempts' || E'\n';
  else bad := bad + 1; r := r || 'FAIL item A changed: ' || v || E'\n'; end if;

  -- ---------- member of A: sees A only, with the Prompt 13 fields ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  select count(*) into n from public.google_drive_category_roots;
  if n = 1 and (select folder_id from public.google_drive_category_roots) = 'sofaRootFolderA1' then
    ok := ok + 1; r := r || 'PASS member of A sees only A''s category root' || E'\n';
  else bad := bad + 1; r := r || 'FAIL member category roots: ' || n || E'\n'; end if;
  select category_root_id || '|' || code_folder_id || '|' || code_folder_name || '|' || jsonb_array_length(match_candidates)
         || '|' || images_skipped || '|' || images_failed, count(*) over ()
    into v, n from public.sync_items;
  if n = 1 and v = 'sofaRootFolderA1|codeSofA001xxxx|SOF-A-001|2|1|1' then
    ok := ok + 1; r := r || 'PASS member of A reads A''s sync_items incl. category_root_id / code_folder_* / match_candidates / images_skipped / images_failed' || E'\n';
  else bad := bad + 1; r := r || 'FAIL member sync_items: ' || coalesce(v, 'null') || ' n=' || n || E'\n'; end if;
  select count(*) into n from public.sync_errors;
  if n = 1 then ok := ok + 1; r := r || 'PASS member of A sees only A''s sync_errors' || E'\n';
  else bad := bad + 1; r := r || 'FAIL member sync_errors: ' || n || E'\n'; end if;

  -- member cannot write (server-only tables / columns), even in their own workspace
  begin update public.sync_items set match_candidates = '[]'::jsonb, images_failed = 0 where id = item_a;
    bad := bad + 1; r := r || 'FAIL member edited sync_items fields' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS members cannot edit sync_items (match_candidates / images_failed …)' || E'\n'; end;
  begin insert into public.sync_items (sync_job_id, store_id, drive_folder_id, category_root_id, code_folder_name)
        values (job_a, s_a, 'forged', 'sofaRootFolderA1', 'SOF-X');
    bad := bad + 1; r := r || 'FAIL member inserted a sync_item' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS members cannot insert sync_items' || E'\n'; end;
  begin update public.sync_errors set resolved = true where id = err_a;
    bad := bad + 1; r := r || 'FAIL member resolved a sync_error directly' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS members cannot modify sync_errors' || E'\n'; end;
  begin delete from public.google_drive_category_roots;
    bad := bad + 1; r := r || 'FAIL member deleted category roots' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS members cannot delete category roots directly' || E'\n'; end;
  begin insert into public.google_drive_category_roots (store_id, connection_id, folder_id, folder_name)
        select s_a, id, 'forgedRootFolder1', 'Forged' from public.google_drive_connections where store_id = s_a;
    bad := bad + 1; r := r || 'FAIL member inserted a category root' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS members cannot insert category roots directly' || E'\n'; end;

  -- ---------- owner of B: sees none of A ----------
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.google_drive_category_roots where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS B cannot see A''s category roots' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B sees A roots: ' || n || E'\n'; end if;
  select count(*) into n from public.google_drive_category_roots;
  if n = 1 then ok := ok + 1; r := r || 'PASS B sees exactly its own category root' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B roots: ' || n || E'\n'; end if;
  select count(*) into n from public.sync_errors where store_id = s_a or id = err_a or sync_job_id = job_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS B cannot see A''s sync_errors (by store, id or job)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B sees A errors: ' || n || E'\n'; end if;
  select count(*) into n from public.sync_items
  where id = item_a or category_root_id = 'sofaRootFolderA1' or code_folder_id = 'codeSofA001xxxx'
     or code_folder_name = 'SOF-A-001' or match_candidates @> '[{"id":"gid://shopify/Product/11"}]'::jsonb;
  if n = 0 then ok := ok + 1; r := r || 'PASS B cannot find A''s sync_items by any Prompt 13 field (category root / code folder / candidates)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B found A items: ' || n || E'\n'; end if;
  select count(*) into n from public.sync_items;
  if n = 1 then ok := ok + 1; r := r || 'PASS B''s aggregates over sync_items include only B rows' || E'\n';
  else bad := bad + 1; r := r || 'FAIL B item count: ' || n || E'\n'; end if;
  begin update public.sync_items set images_failed = 99 where id = item_a;
    bad := bad + 1; r := r || 'FAIL B was allowed to issue an UPDATE on sync_items' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS B cannot update A''s sync_items' || E'\n'; end;
  begin delete from public.sync_errors where id = err_a;
    bad := bad + 1; r := r || 'FAIL B was allowed to delete sync_errors' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS B cannot delete A''s sync_errors' || E'\n'; end;

  -- ---------- signed-in user with no membership ----------
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  select (select count(*) from public.google_drive_category_roots) + (select count(*) from public.sync_errors)
       + (select count(*) from public.sync_items) into n;
  if n = 0 then ok := ok + 1; r := r || 'PASS a signed-in non-member sees no category roots, sync_items or sync_errors' || E'\n';
  else bad := bad + 1; r := r || 'FAIL non-member sees rows: ' || n || E'\n'; end if;

  -- ---------- anon ----------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin perform count(*) from public.google_drive_category_roots;
    bad := bad + 1; r := r || 'FAIL anon read category roots' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot read category roots' || E'\n'; end;
  begin perform count(*) from public.sync_errors;
    bad := bad + 1; r := r || 'FAIL anon read sync_errors' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot read sync_errors' || E'\n'; end;
  begin perform match_candidates from public.sync_items limit 1;
    bad := bad + 1; r := r || 'FAIL anon read sync_items' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot read sync_items' || E'\n'; end;

  -- ---------- membership removed → access gone ----------
  perform set_config('role', 'postgres', true);
  delete from public.workspace_members where workspace_id = ws_a and user_id = m;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  select (select count(*) from public.google_drive_category_roots) + (select count(*) from public.sync_errors)
       + (select count(*) from public.sync_items) into n;
  if n = 0 then ok := ok + 1; r := r || 'PASS a removed member immediately loses access to roots, items and errors' || E'\n';
  else bad := bad + 1; r := r || 'FAIL removed member still sees: ' || n || E'\n'; end if;

  raise exception '%', r || E'\ncross-workspace tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
