-- =============================================================================
-- Product Image Sync — initial multi-tenant schema
--
-- Tenancy:  auth.users → workspace_members → workspaces → stores → store data
--
-- Schemas:
--   public    Exposed through the Supabase Data API. Every table has RLS and
--             explicit, minimal grants (anon gets nothing).
--   private   Helper functions used by RLS policies. Not exposed via the API.
--   internal  Server-only tables (integration_secrets, oauth_states). Not
--             exposed via the API; anon/authenticated have no USAGE on it.
--             Only service_role (server code) can read or write.
--
-- Supabase's default privileges grant ALL on new public tables/functions to
-- anon and authenticated, so this migration revokes them and grants back
-- only what the app needs.
-- =============================================================================

create schema if not exists private;
create schema if not exists internal;

revoke all on schema private from public, anon, authenticated;
revoke all on schema internal from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;
grant usage on schema internal to service_role;

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =============================================================================
-- TABLES
-- =============================================================================

-- profiles --------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (char_length(full_name) <= 200),
  avatar_url  text check (char_length(avatar_url) <= 2048),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'App profile for each auth user. Created automatically on sign-up.';

-- workspaces ------------------------------------------------------------------
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  slug        text check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 64),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.workspaces is 'Tenant container. Create via public.create_workspace().';
create unique index workspaces_slug_key on public.workspaces (slug) where slug is not null;
create index workspaces_created_by_idx on public.workspaces (created_by);

-- workspace_members -----------------------------------------------------------
create table public.workspace_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at    timestamptz not null default now(),
  constraint workspace_members_workspace_user_key unique (workspace_id, user_id)
);
comment on table public.workspace_members is 'Access control: which users belong to which workspace, and their role.';
-- (workspace_id, user_id) unique index also serves workspace_id lookups.
create index workspace_members_workspace_id_idx on public.workspace_members (workspace_id);
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id, role);

-- stores ----------------------------------------------------------------------
create table public.stores (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  shopify_domain  text check (shopify_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  status          text not null default 'setup'
                  check (status in ('setup', 'connected', 'disconnected', 'needs_reconnect', 'error')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Lets child tables prove their store belongs to the same workspace.
  constraint stores_id_workspace_key unique (id, workspace_id),
  constraint stores_workspace_domain_key unique (workspace_id, shopify_domain)
);
comment on table public.stores is 'Shopify stores in a workspace. Never holds tokens.';
comment on column public.stores.shopify_domain is 'Permanent *.myshopify.com domain, lowercase.';
create index stores_workspace_id_idx on public.stores (workspace_id);
create index stores_shopify_domain_idx on public.stores (shopify_domain);
create index stores_status_idx on public.stores (status);

-- shopify_connections (metadata only) -----------------------------------------
create table public.shopify_connections (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores (id) on delete cascade,
  shop_domain        text check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  shopify_shop_id    text,
  connection_status  text not null default 'pending'
                     check (connection_status in ('pending', 'connected', 'disconnected', 'needs_reconnect', 'error')),
  granted_scopes     jsonb not null default '[]'::jsonb check (jsonb_typeof(granted_scopes) = 'array'),
  installed_at       timestamptz,
  last_verified_at   timestamptz,
  token_expires_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint shopify_connections_store_id_key unique (store_id)
);
comment on table public.shopify_connections is 'Shopify connection metadata. Tokens live in internal.integration_secrets.';

-- google_drive_connections (metadata only) ------------------------------------
create table public.google_drive_connections (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores (id) on delete cascade,
  connection_status     text not null default 'pending'
                        check (connection_status in ('pending', 'connected', 'disconnected', 'needs_reconnect', 'error')),
  google_account_email  text,
  root_folder_id        text,
  root_folder_name      text,
  connected_at          timestamptz,
  last_verified_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint google_drive_connections_store_id_key unique (store_id)
);
comment on table public.google_drive_connections is 'Google Drive connection metadata. Tokens live in internal.integration_secrets.';

-- store_settings --------------------------------------------------------------
create table public.store_settings (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores (id) on delete cascade,
  matching_mode        text not null default 'contains' check (matching_mode in ('contains', 'exact')),
  case_insensitive     boolean not null default true,
  trim_spaces          boolean not null default true,
  ignored_folders      text[] not null default array['OG']::text[],
  allowed_image_types  text[] not null default array['jpg', 'jpeg', 'png', 'webp']::text[]
                       check (cardinality(allowed_image_types) > 0
                              and allowed_image_types <@ array['jpg', 'jpeg', 'png', 'webp']::text[]),
  sync_schedule        text check (char_length(sync_schedule) <= 100),
  auto_sync_enabled    boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint store_settings_store_id_key unique (store_id)
);
comment on table public.store_settings is 'Per-store sync settings. A row is created automatically with each store.';

-- product_mappings ------------------------------------------------------------
create table public.product_mappings (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references public.stores (id) on delete cascade,
  drive_folder_id        text not null,
  drive_folder_name      text,
  shopify_product_id     text not null,
  shopify_product_title  text,
  mapping_type           text not null default 'manual' check (mapping_type in ('automatic', 'manual')),
  created_by             uuid default auth.uid() references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint product_mappings_store_folder_key unique (store_id, drive_folder_id)
);
comment on table public.product_mappings is 'Drive product folder → Shopify product. Manual mappings take priority over automatic matching.';
create index product_mappings_store_id_idx on public.product_mappings (store_id);
create index product_mappings_drive_folder_id_idx on public.product_mappings (drive_folder_id);
create index product_mappings_created_by_idx on public.product_mappings (created_by);

-- sync_jobs -------------------------------------------------------------------
create table public.sync_jobs (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id) on delete cascade,
  status              text not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'partially_completed', 'failed')),
  trigger_type        text not null default 'manual' check (trigger_type in ('manual', 'scheduled')),
  started_at          timestamptz,
  completed_at        timestamptz,
  products_processed  integer not null default 0 check (products_processed >= 0),
  products_synced     integer not null default 0 check (products_synced >= 0),
  images_uploaded     integer not null default 0 check (images_uploaded >= 0),
  warnings_count      integer not null default 0 check (warnings_count >= 0),
  errors_count        integer not null default 0 check (errors_count >= 0),
  created_at          timestamptz not null default now(),
  constraint sync_jobs_id_store_key unique (id, store_id),
  constraint sync_jobs_completed_after_started check (completed_at is null or started_at is null or completed_at >= started_at)
);
create index sync_jobs_store_id_idx on public.sync_jobs (store_id, created_at desc);
create index sync_jobs_status_idx on public.sync_jobs (status);

-- sync_items ------------------------------------------------------------------
create table public.sync_items (
  id                     uuid primary key default gen_random_uuid(),
  sync_job_id            uuid not null,
  store_id               uuid not null,
  drive_folder_id        text not null,
  drive_folder_name      text,
  shopify_product_id     text,
  shopify_product_title  text,
  product_status         text,
  status                 text not null default 'pending'
                         check (status in ('pending', 'matched', 'synced', 'no_product_found',
                                           'multiple_matches', 'skipped', 'upload_failed')),
  images_found           integer not null default 0 check (images_found >= 0),
  images_uploaded        integer not null default 0 check (images_uploaded >= 0),
  error_message          text check (char_length(error_message) <= 2000),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint sync_items_id_store_key unique (id, store_id),
  -- Item must belong to the same store as its job.
  constraint sync_items_job_fkey foreign key (sync_job_id, store_id)
    references public.sync_jobs (id, store_id) on delete cascade
);
comment on column public.sync_items.product_status is 'Shopify product status observed at sync time (informational; never changed by sync).';
create index sync_items_job_idx on public.sync_items (sync_job_id, store_id);
create index sync_items_store_id_idx on public.sync_items (store_id);
create index sync_items_status_idx on public.sync_items (store_id, status);

-- sync_images (duplicate-upload protection) -----------------------------------
create table public.sync_images (
  id                  uuid primary key default gen_random_uuid(),
  sync_item_id        uuid,
  store_id            uuid not null references public.stores (id) on delete cascade,
  shopify_product_id  text not null,
  drive_file_id       text not null,
  filename            text not null,
  checksum            text,
  drive_modified_at   timestamptz,
  shopify_media_id    text,
  upload_status       text not null default 'pending'
                      check (upload_status in ('pending', 'uploaded', 'failed', 'skipped')),
  uploaded_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One record per Drive file per Shopify product per store → prevents duplicate uploads.
  constraint sync_images_store_product_file_key unique (store_id, shopify_product_id, drive_file_id),
  -- Latest sync item that touched this image; must be the same store. Null once the item is deleted.
  constraint sync_images_item_fkey foreign key (sync_item_id, store_id)
    references public.sync_items (id, store_id) on delete set null (sync_item_id)
);
comment on table public.sync_images is 'Per-image upload ledger used to skip files already uploaded to a product.';
create index sync_images_drive_file_id_idx on public.sync_images (drive_file_id);
create index sync_images_item_idx on public.sync_images (sync_item_id, store_id);

-- sync_errors -----------------------------------------------------------------
create table public.sync_errors (
  id            uuid primary key default gen_random_uuid(),
  sync_job_id   uuid,
  sync_item_id  uuid,
  store_id      uuid not null references public.stores (id) on delete cascade,
  error_type    text not null check (char_length(error_type) <= 100),
  message       text not null check (char_length(message) <= 2000),
  resolved      boolean not null default false,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint sync_errors_job_fkey foreign key (sync_job_id, store_id)
    references public.sync_jobs (id, store_id) on delete cascade,
  constraint sync_errors_item_fkey foreign key (sync_item_id, store_id)
    references public.sync_items (id, store_id) on delete cascade,
  constraint sync_errors_resolved_consistent check (resolved = (resolved_at is not null))
);
comment on table public.sync_errors is 'Customer-readable sync problems. Never store secrets or raw provider payloads.';
create index sync_errors_store_id_idx on public.sync_errors (store_id, resolved, created_at desc);
create index sync_errors_job_idx on public.sync_errors (sync_job_id, store_id);
create index sync_errors_item_idx on public.sync_errors (sync_item_id, store_id);

-- activity_logs ---------------------------------------------------------------
create table public.activity_logs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  store_id      uuid,
  event_type    text not null check (char_length(event_type) <= 100),
  message       text not null check (char_length(message) <= 2000),
  metadata      jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at    timestamptz not null default now(),
  -- A store-level entry must reference a store in the same workspace.
  constraint activity_logs_store_fkey foreign key (store_id, workspace_id)
    references public.stores (id, workspace_id) on delete cascade
);
comment on table public.activity_logs is 'Human-readable activity feed. Never log tokens, OAuth codes or secrets.';
create index activity_logs_workspace_id_idx on public.activity_logs (workspace_id, created_at desc);
create index activity_logs_store_idx on public.activity_logs (store_id, workspace_id);

-- internal.integration_secrets (server-only) ----------------------------------
create table internal.integration_secrets (
  id                       uuid primary key default gen_random_uuid(),
  connection_id            uuid not null,
  provider                 text not null check (provider in ('shopify', 'google_drive')),
  encrypted_access_token   text,
  encrypted_refresh_token  text,
  token_expires_at         timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint integration_secrets_provider_connection_key unique (provider, connection_id)
);
comment on table internal.integration_secrets is
  'Encrypted provider tokens. Server-only (service_role). Values are encrypted by the app before insert; plaintext tokens must never be stored.';
comment on column internal.integration_secrets.connection_id is
  'shopify_connections.id when provider = shopify; google_drive_connections.id when provider = google_drive.';

-- internal.oauth_states (server-only) -----------------------------------------
create table internal.oauth_states (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('shopify', 'google_drive')),
  state_hash    text not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  store_id      uuid,
  shop_domain   text check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint oauth_states_state_hash_key unique (state_hash),
  constraint oauth_states_store_fkey foreign key (store_id, workspace_id)
    references public.stores (id, workspace_id) on delete cascade
);
comment on table internal.oauth_states is 'One-time OAuth state (only a hash of the state value is stored). Server-only.';
create index oauth_states_expires_at_idx on internal.oauth_states (expires_at);
create index oauth_states_user_id_idx on internal.oauth_states (user_id);
create index oauth_states_workspace_id_idx on internal.oauth_states (workspace_id);
create index oauth_states_store_idx on internal.oauth_states (store_id, workspace_id);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'public.profiles', 'public.workspaces', 'public.stores', 'public.shopify_connections',
    'public.google_drive_connections', 'public.store_settings', 'public.product_mappings',
    'public.sync_items', 'public.sync_images', 'internal.integration_secrets'
  ] loop
    execute format(
      'create trigger set_updated_at before update on %s for each row execute function private.set_updated_at()', t);
  end loop;
end;
$$;

-- Profile row for every new auth user.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    left(new.raw_user_meta_data ->> 'full_name', 200),
    left(new.raw_user_meta_data ->> 'avatar_url', 2048)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Backfill profiles for any users that already exist.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- Default settings row for every new store.
create function private.handle_new_store()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.store_settings (store_id) values (new.id)
  on conflict (store_id) do nothing;
  return new;
end;
$$;

create trigger on_store_created
  after insert on public.stores
  for each row execute function private.handle_new_store();

-- Secrets cannot use a real FK (connection_id is polymorphic), so remove them
-- when their connection is deleted.
create function private.delete_connection_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from internal.integration_secrets
  where connection_id = old.id and provider = tg_argv[0];
  return old;
end;
$$;

create trigger delete_secrets_after_shopify_connection_delete
  after delete on public.shopify_connections
  for each row execute function private.delete_connection_secrets('shopify');

create trigger delete_secrets_after_drive_connection_delete
  after delete on public.google_drive_connections
  for each row execute function private.delete_connection_secrets('google_drive');

-- Membership identity is immutable: only the role may change.
create function private.prevent_membership_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id or new.user_id is distinct from old.user_id then
    raise exception 'workspace_id and user_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger prevent_membership_identity_change
  before update on public.workspace_members
  for each row execute function private.prevent_membership_identity_change();
