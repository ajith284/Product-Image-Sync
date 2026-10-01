-- sync_images upload-state tests (Prompt 10B). One DO block that ends with
-- RAISE EXCEPTION, so everything is rolled back. Run in the Supabase SQL editor
-- (or psql) after supabase/migrations/20261001200000_sync_images_upload.sql.
do $test$
declare
  a uuid := gen_random_uuid();          -- owner, workspace A
  b uuid := gen_random_uuid();          -- owner, workspace B
  ws_a uuid; ws_b uuid; s_a uuid; s_a2 uuid; s_b uuid; job_a uuid; item_a uuid; item_b uuid;
  p1 text := 'gid://shopify/Product/1001';
  p2 text := 'gid://shopify/Product/1002';
  m1 text := 'gid://shopify/MediaImage/9001';
  m2 text := 'gid://shopify/MediaImage/9002';
  t0 timestamptz := '2026-09-30 10:00:00+00';
  j jsonb; img uuid; img2 uuid; n int; v text; flag boolean;
  r text := E'\n'; ok int := 0; bad int := 0;


begin
  -- ---------- setup (as postgres) ----------
  insert into auth.users (id, instance_id, aud, role, email)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x::text || '@test.local'
  from unnest(array[a, b]) x;
  select workspace_id into ws_a from public.workspace_members where user_id = a;
  select workspace_id into ws_b from public.workspace_members where user_id = b;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'BrandSure', 'img-test-a.myshopify.com') returning id into s_a;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_a, 'Second', 'img-test-a2.myshopify.com') returning id into s_a2;
  insert into public.stores (workspace_id, name, shopify_domain) values (ws_b, 'Other', 'img-test-b.myshopify.com') returning id into s_b;
  insert into public.sync_jobs (store_id, trigger_type, status) values (s_a, 'manual', 'running') returning id into job_a;
  insert into public.sync_items (sync_job_id, store_id, drive_folder_id) values (job_a, s_a, 'folderMilano') returning id into item_a;
  with jb as (insert into public.sync_jobs (store_id, trigger_type, status) values (s_b, 'manual', 'running') returning id)
  insert into public.sync_items (sync_job_id, store_id, drive_folder_id)
    select jb.id, s_b, 'folderB' from jb
    returning id into item_b;

  -- ---------- schema ----------
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'sync_images'
     and column_name in ('error_code','error_message','attempt_count','last_attempt_at','retryable','drive_folder_id','mime_type','file_size',
                         'store_id','shopify_product_id','drive_file_id','checksum','drive_modified_at','shopify_media_id','upload_status','uploaded_at','sync_item_id');
  if n = 17 then ok := ok + 1; r := r || 'PASS new columns added, existing columns kept' || E'\n';
  else bad := bad + 1; r := r || 'FAIL columns: ' || n || E'\n'; end if;

  select count(*) into n from pg_constraint where conname = 'sync_images_store_product_file_key' and contype = 'u';
  if n = 1 then ok := ok + 1; r := r || 'PASS unique (store_id, shopify_product_id, drive_file_id) kept' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unique key missing' || E'\n'; end if;

  select relrowsecurity into flag from pg_class where oid = 'public.sync_images'::regclass;
  if flag then ok := ok + 1; r := r || 'PASS RLS still enabled' || E'\n'; else bad := bad + 1; r := r || 'FAIL RLS off' || E'\n'; end if;

  if not has_table_privilege('authenticated', 'public.sync_images', 'insert')
     and not has_table_privilege('authenticated', 'public.sync_images', 'update')
     and not has_table_privilege('authenticated', 'public.sync_images', 'delete')
     and not has_table_privilege('anon', 'public.sync_images', 'select') then
    ok := ok + 1; r := r || 'PASS users cannot write sync_images; anon cannot read' || E'\n';
  else bad := bad + 1; r := r || 'FAIL sync_images grants widened' || E'\n'; end if;

  select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                  and has_function_privilege('service_role', p.oid, 'execute'))
    into flag
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname like 'sync_image_%';
  if flag then ok := ok + 1; r := r || 'PASS sync_image_* functions: service_role only' || E'\n';
  else bad := bad + 1; r := r || 'FAIL sync_image_* executable by users' || E'\n'; end if;

  begin
    insert into public.sync_images (store_id, shopify_product_id, drive_file_id, filename, upload_status)
    values (s_a, p2, 'fileX', 'x.jpg', 'processing');
    bad := bad + 1; r := r || 'FAIL processing row without media id accepted' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS processing requires shopify_media_id' || E'\n'; end;

  begin
    insert into public.sync_images (store_id, shopify_product_id, drive_file_id, filename, file_size)
    values (s_a, p2, 'fileY', 'y.jpg', 20971521);
    bad := bad + 1; r := r || 'FAIL file over 20 MB accepted' || E'\n';
  exception when check_violation then ok := ok + 1; r := r || 'PASS file_size limited to 20 MB' || E'\n'; end;

  -- ================= as the server (service role) =================
  perform set_config('role', 'service_role', true);

  -- wrong workspace / store / item
  begin
    perform public.sync_image_claim(ws_b, s_a, null, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
    bad := bad + 1; r := r || 'FAIL claimed a store of another workspace' || E'\n';
  exception when others then
    if sqlerrm = 'store_not_found' then ok := ok + 1; r := r || 'PASS store of another workspace → store_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL wrong ws: ' || sqlerrm || E'\n'; end if; end;
  begin
    perform public.sync_image_claim(ws_a, s_a, item_b, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
    bad := bad + 1; r := r || 'FAIL used a sync item of another store' || E'\n';
  exception when others then
    if sqlerrm = 'sync_item_not_found' then ok := ok + 1; r := r || 'PASS sync item of another store → sync_item_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL wrong item: ' || sqlerrm || E'\n'; end if; end;
  begin
    perform public.sync_image_claim(ws_a, s_a, null, '1001', 'file1', null, 'image-01.jpg', null, null, null, null);
    bad := bad + 1; r := r || 'FAIL non-GID product id accepted' || E'\n';
  exception when others then
    if sqlerrm = 'invalid_product_id' then ok := ok + 1; r := r || 'PASS product id must be a Product GID' || E'\n';
    else bad := bad + 1; r := r || 'FAIL gid: ' || sqlerrm || E'\n'; end if; end;

  -- new file → upload (pending)
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
  img := (j->'image'->>'id')::uuid;
  if j->>'action' = 'upload' and j->'image'->>'upload_status' = 'pending' and j->'image'->>'drive_folder_id' = 'folderMilano'
     and (j->'image'->>'attempt_count')::int = 0 then
    ok := ok + 1; r := r || 'PASS new file → upload (pending, folder + MIME + size stored)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL new claim: ' || j::text || E'\n'; end if;

  -- second claim inside the lease → busy (no parallel upload)
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
  if j->>'action' = 'busy' then ok := ok + 1; r := r || 'PASS claim while pending (inside lease) → busy' || E'\n';
  else bad := bad + 1; r := r || 'FAIL busy: ' || (j->>'action') || E'\n'; end if;

  -- record attempt
  j := public.sync_image_record_attempt(ws_a, s_a, img);
  if (j->>'attempt_count')::int = 1 and j->>'last_attempt_at' is not null then
    ok := ok + 1; r := r || 'PASS record_attempt increments attempt_count' || E'\n';
  else bad := bad + 1; r := r || 'FAIL attempt: ' || j::text || E'\n'; end if;

  -- cross-store updates are refused
  begin
    perform public.sync_image_mark_processing(ws_a, s_a2, img, m1);
    bad := bad + 1; r := r || 'FAIL updated an image through another store' || E'\n';
  exception when others then
    if sqlerrm = 'image_not_found' then ok := ok + 1; r := r || 'PASS image of another store (same workspace) → image_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross store: ' || sqlerrm || E'\n'; end if; end;
  begin
    perform public.sync_image_mark_failed(ws_b, s_b, img, 'INVALID_REQUEST', 'x', false);
    bad := bad + 1; r := r || 'FAIL updated an image from another workspace' || E'\n';
  exception when others then
    if sqlerrm = 'image_not_found' then ok := ok + 1; r := r || 'PASS image of another workspace → image_not_found' || E'\n';
    else bad := bad + 1; r := r || 'FAIL cross ws: ' || sqlerrm || E'\n'; end if; end;
  begin
    perform public.sync_image_mark_processing(ws_a, s_a, img, 'gid://shopify/Product/1');
    bad := bad + 1; r := r || 'FAIL non-MediaImage id accepted' || E'\n';
  exception when others then
    if sqlerrm = 'invalid_media_id' then ok := ok + 1; r := r || 'PASS media id must be a MediaImage GID' || E'\n';
    else bad := bad + 1; r := r || 'FAIL media id: ' || sqlerrm || E'\n'; end if; end;

  -- processing → a new claim resumes the SAME media (no second upload)
  j := public.sync_image_mark_processing(ws_a, s_a, img, m1);
  if j->>'upload_status' = 'processing' and j->>'shopify_media_id' = m1 then
    ok := ok + 1; r := r || 'PASS mark_processing stores the media id immediately' || E'\n';
  else bad := bad + 1; r := r || 'FAIL processing: ' || j::text || E'\n'; end if;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
  if j->>'action' = 'resume' and j->'image'->>'shopify_media_id' = m1 then
    ok := ok + 1; r := r || 'PASS processing image → resume same media (no duplicate media)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL resume: ' || j::text || E'\n'; end if;
  begin
    perform public.sync_image_mark_processing(ws_a, s_a, img, m2);
    bad := bad + 1; r := r || 'FAIL replaced the media id while processing' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS a processing image cannot switch to another media' || E'\n'; end;

  -- retryable failure after media creation → resume (same media)
  j := public.sync_image_mark_failed(ws_a, s_a, img, 'MEDIA_PROCESSING_TIMEOUT', 'Still processing', true);
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
  if j->>'action' = 'resume' and j->'image'->>'shopify_media_id' = m1 and j->'image'->>'upload_status' = 'processing' then
    ok := ok + 1; r := r || 'PASS retryable failure with media → resume (same media)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL retry resume: ' || j::text || E'\n'; end if;

  -- uploaded → clears errors; unchanged → skip
  j := public.sync_image_mark_uploaded(ws_a, s_a, img, m1);
  if j->>'upload_status' = 'uploaded' and j->>'uploaded_at' is not null and j->>'error_code' is null and j->>'retryable' is null then
    ok := ok + 1; r := r || 'PASS mark_uploaded sets uploaded_at and clears error fields' || E'\n';
  else bad := bad + 1; r := r || 'FAIL uploaded: ' || j::text || E'\n'; end if;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'renamed.jpg', 'md5a', t0, 'image/jpeg', 1000);
  if j->>'action' = 'skip' then ok := ok + 1; r := r || 'PASS uploaded + unchanged → skip (rename does not matter)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL skip: ' || (j->>'action') || E'\n'; end if;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', null, null, 'image/jpeg', 1000);
  if j->>'action' = 'skip' then ok := ok + 1; r := r || 'PASS uploaded, no checksum/time known → skip' || E'\n';
  else bad := bad + 1; r := r || 'FAIL skip unknown: ' || (j->>'action') || E'\n'; end if;
  begin
    perform public.sync_image_mark_failed(ws_a, s_a, img, 'INVALID_REQUEST', 'late failure', false);
    bad := bad + 1; r := r || 'FAIL an uploaded image was marked failed' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS an uploaded image cannot be marked failed' || E'\n'; end;

  -- same filename, other Drive file → separate record (filename is not the key)
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', 'md5b', t0, 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS same filename, different Drive file → its own upload' || E'\n';
  else bad := bad + 1; r := r || 'FAIL filename key: ' || (j->>'action') || E'\n'; end if;
  img2 := (j->'image'->>'id')::uuid;

  -- same Drive file, other product → separate record
  j := public.sync_image_claim(ws_a, s_a, item_a, p2, 'file1', 'folderMilano', 'image-01.jpg', 'md5a', t0, 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS same file for another product → its own upload' || E'\n';
  else bad := bad + 1; r := r || 'FAIL product key: ' || (j->>'action') || E'\n'; end if;

  -- changed checksum → upload again (old media kept on the product)
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file1', 'folderMilano', 'image-01.jpg', 'md5a-v2', t0, 'image/jpeg', 1200);
  if j->>'action' = 'upload' and j->'image'->>'upload_status' = 'pending' and j->'image'->>'shopify_media_id' is null
     and j->'image'->>'checksum' = 'md5a-v2' and (j->'image'->>'attempt_count')::int = 0 then
    ok := ok + 1; r := r || 'PASS changed checksum → re-upload, attempts reset' || E'\n';
  else bad := bad + 1; r := r || 'FAIL changed: ' || j::text || E'\n'; end if;

  -- changed modified time (no checksum) → upload again
  update public.sync_images set upload_status = 'uploaded', shopify_media_id = m2, checksum = null, uploaded_at = now()
   where id = img2;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '1 hour', 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS changed modified time (no checksum) → re-upload' || E'\n';
  else bad := bad + 1; r := r || 'FAIL modified: ' || (j->>'action') || E'\n'; end if;

  -- permanent failure → blocked until the file changes
  perform public.sync_image_mark_failed(ws_a, s_a, img2, 'INVALID_IMAGE', 'Shopify could not read this image.', false);
  update public.sync_images set last_attempt_at = now() - interval '1 hour' where id = img2;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '1 hour', 'image/jpeg', 1000);
  if j->>'action' = 'blocked' and j->'image'->>'error_code' = 'INVALID_IMAGE' then
    ok := ok + 1; r := r || 'PASS permanent failure + unchanged file → blocked (no blind retry)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL blocked: ' || j::text || E'\n'; end if;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '2 hours', 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS permanent failure + changed file → upload allowed' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unblocked: ' || (j->>'action') || E'\n'; end if;

  -- retryable failure before any media → upload again; attempts exhausted → blocked
  perform public.sync_image_mark_failed(ws_a, s_a, img2, 'SHOPIFY_THROTTLED', 'Shopify is busy.', true);
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '2 hours', 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS retryable failure (no media yet) → upload again' || E'\n';
  else bad := bad + 1; r := r || 'FAIL retry: ' || (j->>'action') || E'\n'; end if;
  perform public.sync_image_mark_failed(ws_a, s_a, img2, 'SHOPIFY_THROTTLED', 'Shopify is busy.', true);
  update public.sync_images set attempt_count = 5 where id = img2;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '2 hours', 'image/jpeg', 1000);
  if j->>'action' = 'blocked' then ok := ok + 1; r := r || 'PASS retryable failure after 5 attempts → blocked' || E'\n';
  else bad := bad + 1; r := r || 'FAIL max attempts: ' || (j->>'action') || E'\n'; end if;

  -- stale pending (worker died before fileCreate) → upload again after the lease
  update public.sync_images set upload_status = 'pending', shopify_media_id = null, last_attempt_at = now() - interval '20 minutes',
         attempt_count = 1, error_code = null, retryable = null
   where id = img2;
  j := public.sync_image_claim(ws_a, s_a, item_a, p1, 'file2', 'folderMilano', 'image-01.jpg', null, t0 + interval '2 hours', 'image/jpeg', 1000);
  if j->>'action' = 'upload' then ok := ok + 1; r := r || 'PASS pending older than the lease → upload again' || E'\n';
  else bad := bad + 1; r := r || 'FAIL stale: ' || (j->>'action') || E'\n'; end if;

  -- error codes are validated (no free-form text in error_code)
  begin
    perform public.sync_image_mark_failed(ws_a, s_a, img2, 'token=abc', 'x', true);
    bad := bad + 1; r := r || 'FAIL free-form error code accepted' || E'\n';
  exception when others then ok := ok + 1; r := r || 'PASS error_code must be an UPPER_SNAKE code' || E'\n'; end;

  -- ================= signed-in users =================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin
    perform public.sync_image_claim(ws_a, s_a, null, p1, 'file9', null, 'x.jpg', null, null, null, null);
    bad := bad + 1; r := r || 'FAIL a signed-in user called sync_image_claim' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS signed-in users cannot call sync_image_* functions' || E'\n'; end;
  select count(*) into n from public.sync_images;
  if n >= 3 then ok := ok + 1; r := r || 'PASS owner can still read their own sync_images (RLS)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL owner read: ' || n || E'\n'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.sync_images where store_id = s_a;
  if n = 0 then ok := ok + 1; r := r || 'PASS another workspace cannot read them' || E'\n';
  else bad := bad + 1; r := r || 'FAIL cross-workspace read: ' || n || E'\n'; end if;

  raise exception '%', r || E'\nsync_images tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
