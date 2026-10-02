-- Schema-wide security invariants (Prompt 14B). Read-only catalog checks + one rolled-back
-- create_workspace call. Ends with RAISE EXCEPTION, so nothing is kept.
-- Guards future migrations: a new table without RLS, a new function without a pinned
-- search_path, or a new EXECUTE / table grant to anon / authenticated fails here until the
-- allow-lists below are deliberately updated.
do $test$
declare
  r text := E'\n'; ok int := 0; bad int := 0;
  v text; n int; u uuid := gen_random_uuid(); ws uuid;

  -- Functions signed-in users may call directly. create_workspace is intentional (advisor
  -- warning accepted); the private.* helpers are used inside RLS policies (schema not exposed).
  authed_exec constant text[] := array[
    'public.create_workspace(p_name text, p_slug text)',
    'private.member_store_ids()',
    'private.member_workspace_ids()',
    'private.store_ids_with_role(p_roles text[])',
    'private.visible_profile_ids()',
    'private.workspace_ids_with_role(p_roles text[])'
  ];
  -- Table-level privileges for authenticated (column-level INSERT/UPDATE checked separately).
  authed_tables constant text[] := array[
    'activity_logs:SELECT', 'google_drive_category_roots:SELECT', 'google_drive_connections:SELECT',
    'product_mappings:DELETE,SELECT', 'profiles:SELECT', 'shopify_connections:SELECT', 'store_settings:SELECT',
    'stores:DELETE,SELECT', 'sync_errors:SELECT', 'sync_images:SELECT', 'sync_items:SELECT', 'sync_jobs:SELECT',
    'workspace_members:DELETE,SELECT', 'workspaces:DELETE,SELECT'
  ];
  authed_columns constant text[] := array[
    'product_mappings:INSERT:drive_folder_id,drive_folder_name,mapping_type,shopify_product_id,shopify_product_title,store_id',
    'product_mappings:UPDATE:drive_folder_name,mapping_type,shopify_product_id,shopify_product_title',
    'profiles:UPDATE:avatar_url,full_name',
    'store_settings:UPDATE:allowed_image_types,auto_sync_enabled,case_insensitive,ignored_folders,matching_mode,sync_schedule,trim_spaces',
    'stores:INSERT:name,shopify_domain,workspace_id',
    'stores:UPDATE:name',
    'workspace_members:INSERT:role,user_id,workspace_id',
    'workspace_members:UPDATE:role',
    'workspaces:UPDATE:name,slug'
  ];
  -- Service-only RPCs that must never be callable by anon / authenticated (named explicitly so a
  -- rename or a dropped REVOKE is noticed).
  service_rpcs constant text[] := array[
    'n8n_authenticate', 'n8n_cancel_sync_job', 'n8n_create_sync_job', 'n8n_get_sync_job', 'n8n_list_sync_jobs',
    'n8n_rate_limit_hit', 'n8n_start_sync_job', 'n8n_store_status', 'n8n_touch_api_key', 'n8n_use_nonce',
    'sync_job_claim', 'sync_job_heartbeat', 'sync_job_finish', 'sync_item_record', 'sync_item_update',
    'sync_image_claim', 'sync_image_record_attempt', 'sync_image_mark_processing', 'sync_image_mark_uploaded',
    'sync_image_mark_failed', 'api_key_create', 'api_key_revoke', 'api_keys_list',
    'shopify_begin_oauth', 'shopify_consume_oauth_state', 'shopify_save_connection', 'shopify_get_credentials',
    'shopify_store_refreshed_tokens', 'shopify_record_verification', 'shopify_disconnect',
    'shopify_handle_app_uninstalled', 'shopify_handle_shop_redact', 'shopify_record_webhook',
    'google_begin_oauth', 'google_consume_oauth_state', 'google_save_connection', 'google_get_credentials',
    'google_store_refreshed_tokens', 'google_record_verification', 'google_disconnect',
    'google_add_category_root', 'google_remove_category_root'
  ];
begin
  -- ===================== tables =====================
  select string_agg(n.nspname || '.' || c.relname, ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'internal', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v is null then ok := ok + 1; r := r || 'PASS every table in public / internal / private has RLS enabled' || E'\n';
  else bad := bad + 1; r := r || 'FAIL RLS disabled on: ' || v || E'\n'; end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'internal' and c.relkind = 'r';
  if n >= 6 then ok := ok + 1; r := r || 'PASS internal security tables present (' || n || ')' || E'\n';
  else bad := bad + 1; r := r || 'FAIL expected >= 6 internal tables, found ' || n || E'\n'; end if;

  select string_agg(distinct tablename, ', ') into v from pg_policies where schemaname = 'internal';
  if v is null then ok := ok + 1; r := r || 'PASS internal tables have no policies (server-only by design)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL policies on internal tables: ' || v || E'\n'; end if;

  if not has_schema_privilege('anon', 'internal', 'usage') and not has_schema_privilege('authenticated', 'internal', 'usage') then
    ok := ok + 1; r := r || 'PASS anon / authenticated have no USAGE on schema internal' || E'\n';
  else bad := bad + 1; r := r || 'FAIL USAGE granted on schema internal' || E'\n'; end if;

  if not has_schema_privilege('anon', 'private', 'usage') then
    ok := ok + 1; r := r || 'PASS anon has no USAGE on schema private' || E'\n';
  else bad := bad + 1; r := r || 'FAIL anon has USAGE on private' || E'\n'; end if;

  select string_agg(format('%s.%s %s:%s', n.nspname, c.relname, g.rolname, p), ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) g(rolname)
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
  where n.nspname = 'internal' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    and (case when c.relkind = 'S' then has_sequence_privilege(g.rolname, c.oid, case when p = 'SELECT' then 'SELECT' else 'USAGE' end)
              else has_table_privilege(g.rolname, c.oid, p) end);
  if v is null then ok := ok + 1; r := r || 'PASS anon / authenticated have no privilege on any internal table or sequence' || E'\n';
  else bad := bad + 1; r := r || 'FAIL internal privileges: ' || v || E'\n'; end if;

  select count(*) into n from information_schema.column_privileges
  where table_schema = 'internal' and grantee in ('anon', 'authenticated', 'PUBLIC');
  if n = 0 then ok := ok + 1; r := r || 'PASS no column-level grants on internal tables' || E'\n';
  else bad := bad + 1; r := r || 'FAIL internal column grants: ' || n || E'\n'; end if;

  select string_agg(format('%s:%s', c.relname, p), ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege('anon', c.oid, p);
  if v is null then ok := ok + 1; r := r || 'PASS anon has no privilege on any public table' || E'\n';
  else bad := bad + 1; r := r || 'FAIL anon table privileges: ' || v || E'\n'; end if;

  select count(*) into n from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon', 'PUBLIC');
  if n = 0 then ok := ok + 1; r := r || 'PASS anon / PUBLIC have no column-level grants on public tables' || E'\n';
  else bad := bad + 1; r := r || 'FAIL anon/PUBLIC column grants: ' || n || E'\n'; end if;

  -- authenticated table-level privileges = allow-list exactly
  with actual as (
    select c.relname || ':' || string_agg(p, ',' order by p) as entry
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege('authenticated', c.oid, p)
      -- has_table_privilege() reports table-level grants only; column grants are checked next.
    group by c.relname
  )
  select string_agg(x, ' | ') into v from (
    (select entry x from actual except select unnest(authed_tables))
    union all
    (select '-' || x from (select unnest(authed_tables) x except select entry from actual) m)
  ) d;
  if v is null then ok := ok + 1; r := r || 'PASS authenticated table privileges match the allow-list (' || array_length(authed_tables, 1) || ' tables)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL authenticated table privileges differ: ' || v || E'\n'; end if;

  with actual as (
    select table_name || ':' || privilege_type || ':' || string_agg(column_name, ',' order by column_name) as entry
    from information_schema.column_privileges
    -- (a table-level INSERT/UPDATE would list every column here and fail this check too)
    where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
    group by table_name, privilege_type
  )
  select string_agg(x, ' | ') into v from (
    (select entry x from actual except select unnest(authed_columns))
    union all
    (select '-' || x from (select unnest(authed_columns) x except select entry from actual) m)
  ) d;
  if v is null then ok := ok + 1; r := r || 'PASS authenticated column-level INSERT/UPDATE grants match the allow-list' || E'\n';
  else bad := bad + 1; r := r || 'FAIL authenticated column grants differ: ' || v || E'\n'; end if;

  -- every public table readable by users has an authenticated SELECT policy; no policy targets anon / PUBLIC
  select string_agg(c.relname, ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', c.oid, 'SELECT')
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                    and p.cmd in ('SELECT', 'ALL') and 'authenticated' = any (p.roles));
  if v is null then ok := ok + 1; r := r || 'PASS every user-readable public table has an authenticated SELECT policy' || E'\n';
  else bad := bad + 1; r := r || 'FAIL readable without a SELECT policy: ' || v || E'\n'; end if;

  select string_agg(tablename || ':' || policyname, ', ') into v from pg_policies
  where schemaname in ('public', 'internal', 'private') and (roles && array['anon', 'public']::name[]);
  if v is null then ok := ok + 1; r := r || 'PASS no RLS policy applies to anon or PUBLIC' || E'\n';
  else bad := bad + 1; r := r || 'FAIL policies for anon/PUBLIC: ' || v || E'\n'; end if;

  select string_agg(tablename || ':' || policyname, ', ') into v from pg_policies
  where schemaname = 'public' and (qual ~* 'user_metadata|raw_user_meta_data|app_metadata' or with_check ~* 'user_metadata|raw_user_meta_data');
  if v is null then ok := ok + 1; r := r || 'PASS no policy relies on user-editable metadata' || E'\n';
  else bad := bad + 1; r := r || 'FAIL metadata-based policies: ' || v || E'\n'; end if;

  select string_agg(c.relname, ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
    and not coalesce(array_to_string(c.reloptions, ',') ~ 'security_invoker=(true|on)', false);
  if v is null then ok := ok + 1; r := r || 'PASS no security-definer views in public' || E'\n';
  else bad := bad + 1; r := r || 'FAIL views without security_invoker: ' || v || E'\n'; end if;

  select string_agg(format('%s/%s', n.nspname, d.defaclobjtype), ', ') into v
  from pg_default_acl d join pg_roles ro on ro.oid = d.defaclrole left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  where ro.rolname = 'postgres' and coalesce(n.nspname, 'public') = 'public'
    and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')));
  if v is null then ok := ok + 1; r := r || 'PASS default privileges for new public objects grant nothing to anon / authenticated / PUBLIC' || E'\n';
  else bad := bad + 1; r := r || 'FAIL default privileges: ' || v || E'\n'; end if;

  -- ===================== functions =====================
  select string_agg(n.nspname || '.' || p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'internal') and p.prosecdef
    and not coalesce('search_path=""' = any (p.proconfig), false);
  if v is null then ok := ok + 1; r := r || 'PASS every SECURITY DEFINER function pins search_path to empty' || E'\n';
  else bad := bad + 1; r := r || 'FAIL SECURITY DEFINER without search_path='''': ' || v || E'\n'; end if;

  select string_agg(n.nspname || '.' || p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'internal') and p.prokind = 'f'
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v is null then ok := ok + 1; r := r || 'PASS every application function (definer or invoker) pins a search_path' || E'\n';
  else bad := bad + 1; r := r || 'FAIL functions without search_path: ' || v || E'\n'; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname in ('public', 'private', 'internal') and p.prosecdef;
  if n >= 50 then ok := ok + 1; r := r || 'PASS inventory: ' || n || ' SECURITY DEFINER functions checked' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unexpectedly few SECURITY DEFINER functions: ' || n || E'\n'; end if;

  select string_agg(n.nspname || '.' || p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where n.nspname in ('public', 'private', 'internal') and a.grantee = 0 and a.privilege_type = 'EXECUTE';
  if v is null then ok := ok + 1; r := r || 'PASS no application function is executable by PUBLIC' || E'\n';
  else bad := bad + 1; r := r || 'FAIL EXECUTE granted to PUBLIC: ' || v || E'\n'; end if;

  select string_agg(n.nspname || '.' || p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'internal') and has_function_privilege('anon', p.oid, 'execute');
  if v is null then ok := ok + 1; r := r || 'PASS anon cannot execute any application function' || E'\n';
  else bad := bad + 1; r := r || 'FAIL anon can execute: ' || v || E'\n'; end if;

  with actual as (
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private', 'internal') and has_function_privilege('authenticated', p.oid, 'execute')
  )
  select string_agg(x, ' | ') into v from (
    (select sig x from actual except select unnest(authed_exec))
    union all
    (select '-' || x from (select unnest(authed_exec) x except select sig from actual) m)
  ) d;
  if v is null then ok := ok + 1; r := r || 'PASS authenticated EXECUTE = allow-list exactly (create_workspace + 5 RLS helpers)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL authenticated EXECUTE differs: ' || v || E'\n'; end if;

  select string_agg(s, ', ') into v from unnest(service_rpcs) s
  where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = s);
  if v is null then ok := ok + 1; r := r || 'PASS all ' || array_length(service_rpcs, 1) || ' named service-only RPCs exist' || E'\n';
  else bad := bad + 1; r := r || 'FAIL missing RPCs: ' || v || E'\n'; end if;

  select string_agg(p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any (service_rpcs)
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or not has_function_privilege('service_role', p.oid, 'execute'));
  if v is null then ok := ok + 1; r := r || 'PASS n8n / sync / OAuth / API-key RPCs: service_role only' || E'\n';
  else bad := bad + 1; r := r || 'FAIL service-only RPC grants wrong: ' || v || E'\n'; end if;

  select string_agg(p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
    and not (p.proname = any (service_rpcs) or p.proname = 'create_workspace');
  if v is null then ok := ok + 1; r := r || 'PASS no unlisted public RPC (new functions must be added to an allow-list here)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unlisted public functions: ' || v || E'\n'; end if;

  select string_agg(n.nspname || '.' || p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'internal') and p.prosecdef
    and (select rolsuper from pg_roles where oid = p.proowner) is distinct from true
    and (select rolname from pg_roles where oid = p.proowner) not in ('postgres', 'supabase_admin');
  if v is null then ok := ok + 1; r := r || 'PASS SECURITY DEFINER functions are owned by the migration owner' || E'\n';
  else bad := bad + 1; r := r || 'FAIL unexpected definer owners: ' || v || E'\n'; end if;

  -- ===================== behaviour: create_workspace =====================
  insert into auth.users (id, instance_id, aud, role, email)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u::text || '@inv.local');

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin perform public.create_workspace('Anon WS', 'anon-ws-inv');
    bad := bad + 1; r := r || 'FAIL anon called create_workspace' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot call create_workspace' || E'\n'; end;
  begin perform public.n8n_start_sync_job(gen_random_uuid(), gen_random_uuid(), 'req-anon-1', 'worker-anon-1');
    bad := bad + 1; r := r || 'FAIL anon called n8n_start_sync_job' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS anon cannot call n8n_start_sync_job' || E'\n'; end;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  select w.id into ws from public.create_workspace('Invariant WS', 'invariant-ws-' || left(u::text, 8)) w;
  select count(*) into n from public.workspace_members where workspace_id = ws and user_id = u and role = 'owner';
  if ws is not null and n = 1 then ok := ok + 1; r := r || 'PASS authenticated create_workspace still works (caller becomes owner)' || E'\n';
  else bad := bad + 1; r := r || 'FAIL create_workspace behaviour changed' || E'\n'; end if;

  begin perform public.sync_job_claim(ws, gen_random_uuid(), 'worker-authd-1', 900);
    bad := bad + 1; r := r || 'FAIL authenticated called sync_job_claim' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call sync_job_claim' || E'\n'; end;
  begin perform public.n8n_authenticate('pis_live_xxxxxxxxxxxx');
    bad := bad + 1; r := r || 'FAIL authenticated called n8n_authenticate' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot call n8n_authenticate' || E'\n'; end;
  begin perform count(*) from internal.api_keys;
    bad := bad + 1; r := r || 'FAIL authenticated read internal.api_keys' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot read internal.api_keys' || E'\n'; end;
  begin perform count(*) from internal.api_request_nonces;
    bad := bad + 1; r := r || 'FAIL authenticated read internal.api_request_nonces' || E'\n';
  exception when insufficient_privilege then ok := ok + 1; r := r || 'PASS authenticated cannot read internal.api_request_nonces' || E'\n'; end;

  raise exception '%', r || E'\nsecurity invariant tests: ' || ok || ' passed, ' || bad || ' failed (rolled back)';
end
$test$;
