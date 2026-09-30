-- =============================================================================
-- Shopify OAuth: token lifecycle, one active connection per shop, webhook
-- de-duplication, and server-only RPC functions.
--
-- The RPC functions below are SECURITY DEFINER and executable ONLY by
-- service_role (the app server's Supabase secret key). Browsers (anon /
-- authenticated) cannot call them, and they never return plaintext tokens —
-- tokens are encrypted by the app (AES-256-GCM) before they reach the DB.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Token lifecycle columns (expiring offline tokens: 1 h access, 90 d refresh)
-- -----------------------------------------------------------------------------
alter table internal.integration_secrets
  add column refresh_token_expires_at timestamptz,
  add column token_version integer not null default 1 check (token_version > 0);

comment on column internal.integration_secrets.token_version is
  'Incremented on every token write; used for optimistic concurrency when refreshing.';

alter table public.shopify_connections
  add column refresh_token_expires_at timestamptz,
  add column connected_by uuid references auth.users (id) on delete set null,
  add column disconnected_at timestamptz,
  add column last_error text check (char_length(last_error) <= 500);

comment on column public.shopify_connections.last_error is 'Customer-friendly reason for the current status. Never contains tokens or raw API errors.';
create index shopify_connections_connected_by_idx on public.shopify_connections (connected_by);

-- -----------------------------------------------------------------------------
-- 2. One ACTIVE connection per Shopify shop across ALL workspaces.
--    Re-authorizing a shop issues new tokens and retires older ones, so two
--    workspaces sharing a shop would break each other. Disconnected rows are
--    kept for history and don't count.
-- -----------------------------------------------------------------------------
create unique index shopify_connections_active_shop_key
  on public.shopify_connections (shop_domain)
  where connection_status <> 'disconnected';

-- -----------------------------------------------------------------------------
-- 3. Webhook de-duplication (Shopify may deliver the same webhook more than once)
-- -----------------------------------------------------------------------------
create table internal.webhook_events (
  webhook_id    text primary key check (char_length(webhook_id) between 1 and 200),
  provider      text not null check (provider in ('shopify')),
  topic         text not null check (char_length(topic) <= 100),
  shop_domain   text check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  result        text check (char_length(result) <= 100)
);
comment on table internal.webhook_events is 'Delivered webhook ids (X-Shopify-Webhook-Id) for idempotent processing. Server-only.';
create index webhook_events_received_at_idx on internal.webhook_events (received_at);
create index webhook_events_shop_idx on internal.webhook_events (shop_domain);
alter table internal.webhook_events enable row level security;
revoke all on internal.webhook_events from public, anon, authenticated;
grant all on internal.webhook_events to service_role;

-- -----------------------------------------------------------------------------
-- 4. Helpers (private, not callable by API roles)
-- -----------------------------------------------------------------------------
create function private.is_workspace_manager(p_user_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.user_id = p_user_id and m.workspace_id = p_workspace_id and m.role in ('owner', 'admin')
  );
$$;

create function private.shopify_disconnect_internal(p_store_id uuid, p_reason text, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.shopify_connections;
  v_store public.stores;
begin
  select * into v_store from public.stores where id = p_store_id for update;
  if not found then
    return false;
  end if;

  select * into v_conn from public.shopify_connections where store_id = p_store_id for update;
  if not found then
    return false;
  end if;

  -- Always remove credentials (idempotent).
  delete from internal.integration_secrets where provider = 'shopify' and connection_id = v_conn.id;

  if v_conn.connection_status = 'disconnected' then
    return false; -- already disconnected: no duplicate activity entries
  end if;

  update public.shopify_connections
  set connection_status = 'disconnected',
      disconnected_at = now(),
      token_expires_at = null,
      refresh_token_expires_at = null,
      last_error = case when p_reason = 'uninstalled' then 'The app was removed from this Shopify store.' else null end
  where id = v_conn.id;

  update public.stores set status = 'disconnected' where id = p_store_id;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    v_store.workspace_id,
    p_store_id,
    case when p_reason = 'uninstalled' then 'shopify_uninstalled' else 'shopify_disconnected' end,
    case when p_reason = 'uninstalled' then 'Shopify connection removed.'
         else format('Disconnected Shopify store %s.', v_conn.shop_domain) end,
    jsonb_build_object('shop_domain', v_conn.shop_domain, 'reason', p_reason, 'actor', p_actor)
  );
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Service-only RPC functions (called by the app server with the secret key)
-- -----------------------------------------------------------------------------

-- Start OAuth: re-checks permission + store ownership, blocks shops already
-- connected elsewhere, and stores the HASH of the one-time state.
create function public.shopify_begin_oauth(
  p_user_id uuid,
  p_store_id uuid,
  p_state_hash text,
  p_ttl_seconds integer default 600
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store public.stores;
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' or p_ttl_seconds not between 60 and 1800 then
    raise exception 'invalid_request';
  end if;

  select * into v_store from public.stores where id = p_store_id;
  if not found then
    raise exception 'store_not_found';
  end if;
  if not private.is_workspace_manager(p_user_id, v_store.workspace_id) then
    raise exception 'forbidden';
  end if;
  if v_store.shopify_domain is null or v_store.shopify_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'invalid_shop_domain';
  end if;
  if exists (
    select 1 from public.shopify_connections c
    where c.shop_domain = v_store.shopify_domain
      and c.connection_status <> 'disconnected'
      and c.store_id <> p_store_id
  ) then
    raise exception 'shop_connected_elsewhere';
  end if;

  -- Housekeeping: drop this user's stale states.
  delete from internal.oauth_states
  where user_id = p_user_id and expires_at < now() - interval '1 day';

  insert into internal.oauth_states (provider, state_hash, user_id, workspace_id, store_id, shop_domain, expires_at)
  values ('shopify', p_state_hash, p_user_id, v_store.workspace_id, v_store.id, v_store.shopify_domain,
          now() + make_interval(secs => p_ttl_seconds));

  return v_store.shopify_domain;
end;
$$;

-- Consume a state exactly once. Unknown / reused / expired states are rejected.
create function public.shopify_consume_oauth_state(p_state_hash text)
returns table (status text, user_id uuid, workspace_id uuid, store_id uuid, shop_domain text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v internal.oauth_states;
begin
  select * into v from internal.oauth_states s
  where s.state_hash = p_state_hash and s.provider = 'shopify'
  for update;

  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v.used_at is not null then
    return query select 'reused'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- Mark used even when expired, so it can never be used later.
  update internal.oauth_states set used_at = now() where id = v.id;

  if v.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;

  return query select 'ok'::text, v.user_id, v.workspace_id, v.store_id, v.shop_domain;
end;
$$;

-- Save (or replace on reconnect) the connection + encrypted tokens atomically.
create function public.shopify_save_connection(
  p_store_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_shop_domain text,
  p_scopes text,
  p_encrypted_access_token text,
  p_encrypted_refresh_token text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store public.stores;
  v_existing public.shopify_connections;
  v_conn_id uuid;
  v_reconnect boolean;
begin
  if p_encrypted_access_token is null or p_encrypted_access_token !~ '^v1\.' then
    raise exception 'invalid_request'; -- only app-encrypted values are accepted
  end if;
  if p_encrypted_refresh_token is not null and p_encrypted_refresh_token !~ '^v1\.' then
    raise exception 'invalid_request';
  end if;

  select * into v_store from public.stores where id = p_store_id for update;
  if not found or v_store.workspace_id <> p_workspace_id or v_store.shopify_domain is distinct from p_shop_domain then
    raise exception 'store_mismatch';
  end if;
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden';
  end if;

  select * into v_existing from public.shopify_connections where store_id = p_store_id for update;
  v_reconnect := found;

  begin
    insert into public.shopify_connections as c (
      store_id, shop_domain, connection_status, granted_scopes, installed_at,
      token_expires_at, refresh_token_expires_at, connected_by, disconnected_at, last_error
    )
    values (
      p_store_id, p_shop_domain, 'pending',
      to_jsonb(array(select btrim(s) from unnest(string_to_array(p_scopes, ',')) s where btrim(s) <> '')),
      now(), p_access_expires_at, p_refresh_expires_at, p_user_id, null, null
    )
    on conflict (store_id) do update set
      shop_domain = excluded.shop_domain,
      connection_status = 'pending',
      granted_scopes = excluded.granted_scopes,
      installed_at = excluded.installed_at,
      token_expires_at = excluded.token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      connected_by = excluded.connected_by,
      disconnected_at = null,
      last_error = null
    returning c.id into v_conn_id;
  exception when unique_violation then
    raise exception 'shop_connected_elsewhere';
  end;

  insert into internal.integration_secrets as s (
    connection_id, provider, encrypted_access_token, encrypted_refresh_token,
    token_expires_at, refresh_token_expires_at
  )
  values (
    v_conn_id, 'shopify', p_encrypted_access_token, p_encrypted_refresh_token,
    p_access_expires_at, p_refresh_expires_at
  )
  on conflict (provider, connection_id) do update set
    encrypted_access_token = excluded.encrypted_access_token,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    token_expires_at = excluded.token_expires_at,
    refresh_token_expires_at = excluded.refresh_token_expires_at,
    token_version = s.token_version + 1;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    p_workspace_id, p_store_id,
    case when v_reconnect then 'shopify_reconnected' else 'shopify_connected' end,
    format('%s Shopify store %s.', case when v_reconnect then 'Reconnected' else 'Connected' end, p_shop_domain),
    jsonb_build_object('shop_domain', p_shop_domain, 'actor', p_user_id)
  );

  return v_conn_id;
end;
$$;

-- Read encrypted credentials for server-side use (verify / refresh / API calls).
create function public.shopify_get_credentials(p_store_id uuid)
returns table (
  connection_id uuid,
  workspace_id uuid,
  shop_domain text,
  connection_status text,
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  token_version integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, st.workspace_id, c.shop_domain, c.connection_status,
         s.encrypted_access_token, s.encrypted_refresh_token,
         s.token_expires_at, s.refresh_token_expires_at, s.token_version
  from public.shopify_connections c
  join public.stores st on st.id = c.store_id
  join internal.integration_secrets s on s.connection_id = c.id and s.provider = 'shopify'
  where c.store_id = p_store_id and c.connection_status <> 'disconnected';
$$;

-- Store refreshed tokens only if nobody else refreshed first (optimistic lock).
create function public.shopify_store_refreshed_tokens(
  p_connection_id uuid,
  p_expected_version integer,
  p_encrypted_access_token text,
  p_encrypted_refresh_token text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_encrypted_access_token !~ '^v1\.' or (p_encrypted_refresh_token is not null and p_encrypted_refresh_token !~ '^v1\.') then
    raise exception 'invalid_request';
  end if;

  update internal.integration_secrets
  set encrypted_access_token = p_encrypted_access_token,
      encrypted_refresh_token = coalesce(p_encrypted_refresh_token, encrypted_refresh_token),
      token_expires_at = p_access_expires_at,
      refresh_token_expires_at = coalesce(p_refresh_expires_at, refresh_token_expires_at),
      token_version = token_version + 1
  where connection_id = p_connection_id and provider = 'shopify' and token_version = p_expected_version;

  if not found then
    return false;
  end if;

  update public.shopify_connections
  set token_expires_at = p_access_expires_at,
      refresh_token_expires_at = coalesce(p_refresh_expires_at, refresh_token_expires_at)
  where id = p_connection_id;
  return true;
end;
$$;

-- Record the result of a read-only connection check.
create function public.shopify_record_verification(
  p_store_id uuid,
  p_ok boolean,
  p_failure_status text default null,
  p_shopify_shop_id text default null,
  p_error text default null,
  p_log boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.shopify_connections;
  v_workspace uuid;
  v_status text := case when p_ok then 'connected' else coalesce(p_failure_status, 'error') end;
begin
  if v_status not in ('connected', 'needs_reconnect', 'error') then
    raise exception 'invalid_request';
  end if;

  select c.* into v_conn from public.shopify_connections c where c.store_id = p_store_id for update;
  if not found or v_conn.connection_status = 'disconnected' then
    return;
  end if;
  select workspace_id into v_workspace from public.stores where id = p_store_id;

  update public.shopify_connections
  set connection_status = v_status,
      last_verified_at = case when p_ok then now() else last_verified_at end,
      shopify_shop_id = coalesce(p_shopify_shop_id, shopify_shop_id),
      last_error = case when p_ok then null else left(p_error, 500) end
  where id = v_conn.id;

  update public.stores set status = v_status where id = p_store_id;

  if p_log or v_conn.connection_status is distinct from v_status then
    insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
    values (
      v_workspace, p_store_id,
      case when p_ok then 'shopify_verified' else 'shopify_verification_failed' end,
      case when p_ok then format('Verified Shopify connection to %s.', v_conn.shop_domain)
           else coalesce(left(p_error, 500), 'Shopify connection check failed.') end,
      jsonb_build_object('shop_domain', v_conn.shop_domain, 'status', v_status)
    );
  end if;
end;
$$;

-- User-initiated disconnect (permission re-checked here).
create function public.shopify_disconnect(p_store_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace uuid;
begin
  select workspace_id into v_workspace from public.stores where id = p_store_id;
  if not found then
    raise exception 'store_not_found';
  end if;
  if not private.is_workspace_manager(p_user_id, v_workspace) then
    raise exception 'forbidden';
  end if;
  return private.shopify_disconnect_internal(p_store_id, 'user', p_user_id);
end;
$$;

-- Record a webhook delivery once. Returns false for duplicates.
create function public.shopify_record_webhook(p_webhook_id text, p_topic text, p_shop_domain text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into internal.webhook_events (webhook_id, provider, topic, shop_domain)
  values (p_webhook_id, 'shopify', p_topic, p_shop_domain)
  on conflict (webhook_id) do nothing;
  return found;
end;
$$;

-- app/uninstalled: idempotent (dedupe by webhook id + disconnect is idempotent).
create function public.shopify_handle_app_uninstalled(p_webhook_id text, p_shop_domain text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store_id uuid;
  v_changed boolean := false;
begin
  if not public.shopify_record_webhook(p_webhook_id, 'app/uninstalled', p_shop_domain) then
    return 'duplicate';
  end if;

  for v_store_id in
    select c.store_id from public.shopify_connections c
    where c.shop_domain = p_shop_domain and c.connection_status <> 'disconnected'
  loop
    v_changed := private.shopify_disconnect_internal(v_store_id, 'uninstalled', null) or v_changed;
  end loop;

  update internal.webhook_events
  set processed_at = now(), result = case when v_changed then 'disconnected' else 'no_active_connection' end
  where webhook_id = p_webhook_id;

  return case when v_changed then 'disconnected' else 'no_active_connection' end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants: service_role only
-- -----------------------------------------------------------------------------
revoke execute on function
  private.is_workspace_manager(uuid, uuid),
  private.shopify_disconnect_internal(uuid, text, uuid)
from public, anon, authenticated;

revoke execute on function
  public.shopify_begin_oauth(uuid, uuid, text, integer),
  public.shopify_consume_oauth_state(text),
  public.shopify_save_connection(uuid, uuid, uuid, text, text, text, text, timestamptz, timestamptz),
  public.shopify_get_credentials(uuid),
  public.shopify_store_refreshed_tokens(uuid, integer, text, text, timestamptz, timestamptz),
  public.shopify_record_verification(uuid, boolean, text, text, text, boolean),
  public.shopify_disconnect(uuid, uuid),
  public.shopify_record_webhook(text, text, text),
  public.shopify_handle_app_uninstalled(text, text)
from public, anon, authenticated;

grant execute on function
  public.shopify_begin_oauth(uuid, uuid, text, integer),
  public.shopify_consume_oauth_state(text),
  public.shopify_save_connection(uuid, uuid, uuid, text, text, text, text, timestamptz, timestamptz),
  public.shopify_get_credentials(uuid),
  public.shopify_store_refreshed_tokens(uuid, integer, text, text, timestamptz, timestamptz),
  public.shopify_record_verification(uuid, boolean, text, text, text, boolean),
  public.shopify_disconnect(uuid, uuid),
  public.shopify_record_webhook(text, text, text),
  public.shopify_handle_app_uninstalled(text, text)
to service_role;
