-- =============================================================================
-- Product Image Sync — Row Level Security, grants and access helpers
--
-- Rule: a user sees a row only if they are a member of the workspace that owns
-- it (directly, or through the row's store). Membership lives in
-- public.workspace_members; user_metadata is never used for authorization.
--
-- Roles:
--   owner   everything, incl. deleting the workspace and managing admins
--   admin   manage stores, store settings and 'member' users
--   member  read workspace data, manage manual product mappings
--
-- Sync data (jobs, items, images, errors, activity) and connection metadata
-- are read-only for users; only server code (service_role) writes them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Access helpers (SECURITY DEFINER so policies can read workspace_members
-- without recursive RLS; search_path pinned; not exposed through the API).
-- -----------------------------------------------------------------------------
create function private.member_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid());
$$;

create function private.workspace_ids_with_role(p_roles text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid())
    and m.role = any (p_roles);
$$;

create function private.member_store_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.stores s
  join public.workspace_members m on m.workspace_id = s.workspace_id
  where m.user_id = (select auth.uid());
$$;

create function private.store_ids_with_role(p_roles text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.stores s
  join public.workspace_members m on m.workspace_id = s.workspace_id
  where m.user_id = (select auth.uid())
    and m.role = any (p_roles);
$$;

create function private.visible_profile_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid())
  union
  select other.user_id
  from public.workspace_members mine
  join public.workspace_members other on other.workspace_id = mine.workspace_id
  where mine.user_id = (select auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere (internal tables: enabled with NO policies → only
-- service_role, which bypasses RLS, can touch them).
-- -----------------------------------------------------------------------------
alter table public.profiles                 enable row level security;
alter table public.workspaces               enable row level security;
alter table public.workspace_members        enable row level security;
alter table public.stores                   enable row level security;
alter table public.shopify_connections      enable row level security;
alter table public.google_drive_connections enable row level security;
alter table public.store_settings           enable row level security;
alter table public.product_mappings         enable row level security;
alter table public.sync_jobs                enable row level security;
alter table public.sync_items               enable row level security;
alter table public.sync_images              enable row level security;
alter table public.sync_errors              enable row level security;
alter table public.activity_logs            enable row level security;
alter table internal.integration_secrets    enable row level security;
alter table internal.oauth_states           enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create policy "profiles: read self and co-members"
  on public.profiles for select to authenticated
  using (id in (select private.visible_profile_ids()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- workspaces  (insert only through public.create_workspace)
-- -----------------------------------------------------------------------------
create policy "workspaces: members read"
  on public.workspaces for select to authenticated
  using (id in (select private.member_workspace_ids()));

create policy "workspaces: owners and admins update"
  on public.workspaces for update to authenticated
  using (id in (select private.workspace_ids_with_role(array['owner', 'admin'])))
  with check (id in (select private.workspace_ids_with_role(array['owner', 'admin'])));

create policy "workspaces: owners delete"
  on public.workspaces for delete to authenticated
  using (id in (select private.workspace_ids_with_role(array['owner'])));

-- -----------------------------------------------------------------------------
-- workspace_members
--   * nobody can create or edit an 'owner' row through the API
--   * owners add/promote admins and members; admins add members only
--   * nobody can change their own role
--   * anyone except the owner can leave
-- -----------------------------------------------------------------------------
create policy "members: members read their workspace roster"
  on public.workspace_members for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));

create policy "members: owners add admins/members, admins add members"
  on public.workspace_members for insert to authenticated
  with check (
    user_id <> (select auth.uid())
    and (
      (role = 'member' and workspace_id in (select private.workspace_ids_with_role(array['owner', 'admin'])))
      or (role = 'admin' and workspace_id in (select private.workspace_ids_with_role(array['owner'])))
    )
  );

create policy "members: owners change other non-owner roles"
  on public.workspace_members for update to authenticated
  using (
    role <> 'owner'
    and user_id <> (select auth.uid())
    and workspace_id in (select private.workspace_ids_with_role(array['owner']))
  )
  with check (
    role in ('admin', 'member')
    and user_id <> (select auth.uid())
    and workspace_id in (select private.workspace_ids_with_role(array['owner']))
  );

create policy "members: leave, or remove as owner/admin"
  on public.workspace_members for delete to authenticated
  using (
    role <> 'owner'
    and (
      user_id = (select auth.uid())
      or workspace_id in (select private.workspace_ids_with_role(array['owner']))
      or (role = 'member' and workspace_id in (select private.workspace_ids_with_role(array['admin'])))
    )
  );

-- -----------------------------------------------------------------------------
-- stores
-- -----------------------------------------------------------------------------
create policy "stores: members read"
  on public.stores for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));

create policy "stores: owners and admins create"
  on public.stores for insert to authenticated
  with check (workspace_id in (select private.workspace_ids_with_role(array['owner', 'admin'])));

create policy "stores: owners and admins update"
  on public.stores for update to authenticated
  using (workspace_id in (select private.workspace_ids_with_role(array['owner', 'admin'])))
  with check (workspace_id in (select private.workspace_ids_with_role(array['owner', 'admin'])));

create policy "stores: owners and admins delete"
  on public.stores for delete to authenticated
  using (workspace_id in (select private.workspace_ids_with_role(array['owner', 'admin'])));

-- -----------------------------------------------------------------------------
-- Connection metadata: read-only for members (server writes)
-- -----------------------------------------------------------------------------
create policy "shopify_connections: members read"
  on public.shopify_connections for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "google_drive_connections: members read"
  on public.google_drive_connections for select to authenticated
  using (store_id in (select private.member_store_ids()));

-- -----------------------------------------------------------------------------
-- store_settings (row auto-created with the store)
-- -----------------------------------------------------------------------------
create policy "store_settings: members read"
  on public.store_settings for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "store_settings: owners and admins update"
  on public.store_settings for update to authenticated
  using (store_id in (select private.store_ids_with_role(array['owner', 'admin'])))
  with check (store_id in (select private.store_ids_with_role(array['owner', 'admin'])));

-- -----------------------------------------------------------------------------
-- product_mappings: any member may create/edit manual mappings
-- -----------------------------------------------------------------------------
create policy "product_mappings: members read"
  on public.product_mappings for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "product_mappings: members create manual mappings"
  on public.product_mappings for insert to authenticated
  with check (
    store_id in (select private.member_store_ids())
    and mapping_type = 'manual'
    and created_by = (select auth.uid())
  );

create policy "product_mappings: members update to manual"
  on public.product_mappings for update to authenticated
  using (store_id in (select private.member_store_ids()))
  with check (store_id in (select private.member_store_ids()) and mapping_type = 'manual');

create policy "product_mappings: members delete"
  on public.product_mappings for delete to authenticated
  using (store_id in (select private.member_store_ids()));

-- -----------------------------------------------------------------------------
-- Sync history + activity: read-only for members
-- -----------------------------------------------------------------------------
create policy "sync_jobs: members read"
  on public.sync_jobs for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "sync_items: members read"
  on public.sync_items for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "sync_images: members read"
  on public.sync_images for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "sync_errors: members read"
  on public.sync_errors for select to authenticated
  using (store_id in (select private.member_store_ids()));

create policy "activity_logs: members read"
  on public.activity_logs for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));

-- -----------------------------------------------------------------------------
-- Workspace creation RPC: creates the workspace and the caller's owner row
-- atomically (the only way an 'owner' membership is created via the API).
-- -----------------------------------------------------------------------------
create function public.create_workspace(p_name text, p_slug text default null)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_workspace public.workspaces;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  insert into public.workspaces (name, slug, created_by)
  values (btrim(p_name), nullif(lower(btrim(p_slug)), ''), v_user)
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace.id, v_user, 'owner');

  return v_workspace;
end;
$$;
comment on function public.create_workspace(text, text) is
  'Creates a workspace owned by the calling user. Returns the new workspace.';

-- =============================================================================
-- GRANTS — least privilege
-- =============================================================================

-- Start from nothing for API roles on app tables.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema internal from public, anon, authenticated;

-- Server (service_role) keeps full access; it bypasses RLS.
grant all on all tables in schema public to service_role;
grant all on all tables in schema internal to service_role;

-- Signed-in users: read everything RLS allows.
grant select on
  public.profiles, public.workspaces, public.workspace_members, public.stores,
  public.shopify_connections, public.google_drive_connections, public.store_settings,
  public.product_mappings, public.sync_jobs, public.sync_items, public.sync_images,
  public.sync_errors, public.activity_logs
to authenticated;

-- Writes: only the columns users are meant to change.
grant update (full_name, avatar_url) on public.profiles to authenticated;

grant update (name, slug) on public.workspaces to authenticated;
grant delete on public.workspaces to authenticated;

grant insert (workspace_id, user_id, role) on public.workspace_members to authenticated;
grant update (role) on public.workspace_members to authenticated;
grant delete on public.workspace_members to authenticated;

-- status is server-managed; shopify_domain is fixed after creation.
grant insert (workspace_id, name, shopify_domain) on public.stores to authenticated;
grant update (name) on public.stores to authenticated;
grant delete on public.stores to authenticated;

grant update (matching_mode, case_insensitive, trim_spaces, ignored_folders,
              allowed_image_types, sync_schedule, auto_sync_enabled)
  on public.store_settings to authenticated;

grant insert (store_id, drive_folder_id, drive_folder_name, shopify_product_id,
              shopify_product_title, mapping_type)
  on public.product_mappings to authenticated;
grant update (drive_folder_name, shopify_product_id, shopify_product_title, mapping_type)
  on public.product_mappings to authenticated;
grant delete on public.product_mappings to authenticated;

-- Functions: nothing is executable by default.
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.create_workspace(text, text) from public, anon;

grant execute on function
  private.member_workspace_ids(),
  private.workspace_ids_with_role(text[]),
  private.member_store_ids(),
  private.store_ids_with_role(text[]),
  private.visible_profile_ids()
to authenticated;
grant execute on function public.create_workspace(text, text) to authenticated, service_role;

-- Future objects created by migrations (role postgres) are NOT exposed to
-- anon/authenticated automatically. Every new table/function must be granted
-- explicitly, together with its RLS policies.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
