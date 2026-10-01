-- =============================================================================
-- Google Drive OAuth foundation (Prompt 6).
--
-- Reuses the existing server-only tables:
--   internal.oauth_states        (provider = 'google_drive')  one-time, hashed state
--   internal.integration_secrets (provider = 'google_drive')  app-encrypted tokens
-- and adds token-lifecycle / audit columns to public.google_drive_connections.
--
-- All RPC functions are SECURITY DEFINER and executable ONLY by service_role
-- (the app server's Supabase secret key). They re-check permissions, only
-- accept app-encrypted ("v1.") token values and never return plaintext.
-- No folder selection / Drive scanning here (Prompt 7).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Connection metadata (no tokens ever live in this table)
-- -----------------------------------------------------------------------------
alter table public.google_drive_connections
  add column google_account_id text check (char_length(google_account_id) between 1 and 255),
  add column granted_scopes jsonb not null default '[]'::jsonb check (jsonb_typeof(granted_scopes) = 'array'),
  add column token_expires_at timestamptz,
  add column connected_by uuid references auth.users (id) on delete set null,
  add column disconnected_at timestamptz,
  add column last_error text check (char_length(last_error) <= 500),
  add constraint google_drive_connections_email_length check (char_length(google_account_email) <= 320);

comment on column public.google_drive_connections.google_account_id is 'Google account subject id (OpenID "sub"). Stable even if the email changes.';
comment on column public.google_drive_connections.last_error is 'Customer-friendly reason for the current status. Never contains tokens or raw API errors.';

create index google_drive_connections_connected_by_idx on public.google_drive_connections (connected_by);
create index google_drive_connections_account_idx
  on public.google_drive_connections (google_account_id)
  where connection_status <> 'disconnected';

-- Members may read the new display fields (column-level grants, like the others).
grant select (granted_scopes, disconnected_at, last_error) on public.google_drive_connections to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Internal helper
-- -----------------------------------------------------------------------------
create function private.google_disconnect_internal(p_store_id uuid, p_reason text, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.google_drive_connections;
  v_store public.stores;
begin
  select * into v_store from public.stores where id = p_store_id for update;
  if not found then
    return false;
  end if;

  select * into v_conn from public.google_drive_connections where store_id = p_store_id for update;
  if not found then
    return false;
  end if;

  -- Always remove credentials (idempotent).
  delete from internal.integration_secrets where provider = 'google_drive' and connection_id = v_conn.id;

  if v_conn.connection_status = 'disconnected' then
    return false;
  end if;

  update public.google_drive_connections
  set connection_status = 'disconnected',
      disconnected_at = now(),
      token_expires_at = null,
      last_error = null
  where id = v_conn.id;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    v_store.workspace_id, p_store_id, 'google_drive_disconnected',
    'Disconnected Google Drive.',
    jsonb_build_object('reason', p_reason, 'actor', p_actor)
  );
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Service-only RPC functions
-- -----------------------------------------------------------------------------

-- Start OAuth: re-check permission + store, store only the HASH of the state.
create function public.google_begin_oauth(
  p_user_id uuid,
  p_store_id uuid,
  p_state_hash text,
  p_ttl_seconds integer default 600
)
returns uuid
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

  delete from internal.oauth_states
  where user_id = p_user_id and expires_at < now() - interval '1 day';

  insert into internal.oauth_states (provider, state_hash, user_id, workspace_id, store_id, expires_at)
  values ('google_drive', p_state_hash, p_user_id, v_store.workspace_id, v_store.id,
          now() + make_interval(secs => p_ttl_seconds));

  return v_store.id;
end;
$$;

-- Consume a Google state exactly once. Unknown / reused / expired are rejected.
-- A Shopify state can never be consumed here (provider filter).
create function public.google_consume_oauth_state(p_state_hash text)
returns table (status text, user_id uuid, workspace_id uuid, store_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v internal.oauth_states;
begin
  select * into v from internal.oauth_states s
  where s.state_hash = p_state_hash and s.provider = 'google_drive'
  for update;

  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v.used_at is not null then
    return query select 'reused'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  update internal.oauth_states set used_at = now() where id = v.id;

  if v.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  return query select 'ok'::text, v.user_id, v.workspace_id, v.store_id;
end;
$$;

-- Save (or replace on reconnect) the connection + encrypted tokens atomically.
-- p_encrypted_refresh_token may be null only when reconnecting the SAME Google
-- account that already has a stored refresh token.
-- Switching to a different Google account clears the selected root folder.
create function public.google_save_connection(
  p_store_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_google_account_id text,
  p_google_account_email text,
  p_scopes text,
  p_encrypted_access_token text,
  p_encrypted_refresh_token text,
  p_access_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store public.stores;
  v_existing public.google_drive_connections;
  v_had boolean;
  v_same_account boolean;
  v_has_refresh boolean;
  v_conn_id uuid;
begin
  if p_encrypted_access_token is null or p_encrypted_access_token !~ '^v1\.' then
    raise exception 'invalid_request';
  end if;
  if p_encrypted_refresh_token is not null and p_encrypted_refresh_token !~ '^v1\.' then
    raise exception 'invalid_request';
  end if;
  if p_google_account_id is null or btrim(p_google_account_id) = '' then
    raise exception 'invalid_request';
  end if;

  select * into v_store from public.stores where id = p_store_id for update;
  if not found or v_store.workspace_id <> p_workspace_id then
    raise exception 'store_mismatch';
  end if;
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden';
  end if;

  select * into v_existing from public.google_drive_connections where store_id = p_store_id for update;
  v_had := found;
  v_same_account := v_had and v_existing.google_account_id is not distinct from p_google_account_id;

  if p_encrypted_refresh_token is null then
    select exists (
      select 1 from internal.integration_secrets s
      where s.provider = 'google_drive' and s.connection_id = v_existing.id and s.encrypted_refresh_token is not null
    ) into v_has_refresh;
    if not (v_same_account and v_has_refresh) then
      raise exception 'missing_refresh_token';
    end if;
  end if;

  insert into public.google_drive_connections as c (
    store_id, connection_status, google_account_id, google_account_email, granted_scopes,
    connected_at, token_expires_at, connected_by, disconnected_at, last_error
  )
  values (
    p_store_id, 'pending', p_google_account_id, left(p_google_account_email, 320),
    to_jsonb(array(select s from unnest(regexp_split_to_array(btrim(coalesce(p_scopes, '')), '\s+')) s where s <> '')),
    now(), p_access_expires_at, p_user_id, null, null
  )
  on conflict (store_id) do update set
    connection_status = 'pending',
    google_account_id = excluded.google_account_id,
    google_account_email = excluded.google_account_email,
    granted_scopes = excluded.granted_scopes,
    connected_at = excluded.connected_at,
    token_expires_at = excluded.token_expires_at,
    connected_by = excluded.connected_by,
    disconnected_at = null,
    last_error = null,
    -- A different Google account can't see the previous account's folder.
    root_folder_id = case when v_same_account then c.root_folder_id else null end,
    root_folder_name = case when v_same_account then c.root_folder_name else null end
  returning c.id into v_conn_id;

  insert into internal.integration_secrets as s (
    connection_id, provider, encrypted_access_token, encrypted_refresh_token, token_expires_at
  )
  values (v_conn_id, 'google_drive', p_encrypted_access_token, p_encrypted_refresh_token, p_access_expires_at)
  on conflict (provider, connection_id) do update set
    encrypted_access_token = excluded.encrypted_access_token,
    encrypted_refresh_token = coalesce(excluded.encrypted_refresh_token, s.encrypted_refresh_token),
    token_expires_at = excluded.token_expires_at,
    refresh_token_expires_at = null,
    token_version = s.token_version + 1;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    p_workspace_id, p_store_id,
    case when v_had then 'google_drive_reconnected' else 'google_drive_connected' end,
    format('%s Google Drive (%s).', case when v_had then 'Reconnected' else 'Connected' end,
           coalesce(left(p_google_account_email, 320), 'Google account')),
    jsonb_build_object('actor', p_user_id, 'account_changed', v_had and not v_same_account)
  );

  return v_conn_id;
end;
$$;

-- Encrypted credentials for server-side use. `account_shared` = another active
-- connection uses the same Google account (revoking would break it too).
create function public.google_get_credentials(p_store_id uuid)
returns table (
  connection_id uuid,
  workspace_id uuid,
  google_account_id text,
  connection_status text,
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  token_version integer,
  account_shared boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, st.workspace_id, c.google_account_id, c.connection_status,
         s.encrypted_access_token, s.encrypted_refresh_token, s.token_expires_at, s.token_version,
         exists (
           select 1 from public.google_drive_connections o
           where o.google_account_id = c.google_account_id
             and o.id <> c.id
             and o.connection_status <> 'disconnected'
         )
  from public.google_drive_connections c
  join public.stores st on st.id = c.store_id
  join internal.integration_secrets s on s.connection_id = c.id and s.provider = 'google_drive'
  where c.store_id = p_store_id and c.connection_status <> 'disconnected';
$$;

-- Store a refreshed access token only if nobody refreshed first (optimistic lock).
create function public.google_store_refreshed_tokens(
  p_connection_id uuid,
  p_expected_version integer,
  p_encrypted_access_token text,
  p_encrypted_refresh_token text,
  p_access_expires_at timestamptz
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
      token_version = token_version + 1
  where connection_id = p_connection_id and provider = 'google_drive' and token_version = p_expected_version;

  if not found then
    return false;
  end if;

  update public.google_drive_connections set token_expires_at = p_access_expires_at where id = p_connection_id;
  return true;
end;
$$;

-- Record the result of a read-only connection check.
create function public.google_record_verification(
  p_store_id uuid,
  p_ok boolean,
  p_failure_status text default null,
  p_account_email text default null,
  p_error text default null,
  p_log boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.google_drive_connections;
  v_workspace uuid;
  v_status text := case when p_ok then 'connected' else coalesce(p_failure_status, 'error') end;
begin
  if v_status not in ('connected', 'needs_reconnect', 'error') then
    raise exception 'invalid_request';
  end if;

  select c.* into v_conn from public.google_drive_connections c where c.store_id = p_store_id for update;
  if not found or v_conn.connection_status = 'disconnected' then
    return;
  end if;
  select workspace_id into v_workspace from public.stores where id = p_store_id;

  update public.google_drive_connections
  set connection_status = v_status,
      last_verified_at = case when p_ok then now() else last_verified_at end,
      google_account_email = coalesce(left(p_account_email, 320), google_account_email),
      last_error = case when p_ok then null else left(p_error, 500) end
  where id = v_conn.id;

  if p_log or v_conn.connection_status is distinct from v_status then
    insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
    values (
      v_workspace, p_store_id,
      case when p_ok then 'google_drive_verified' else 'google_drive_verification_failed' end,
      case when p_ok then 'Verified Google Drive connection.'
           else coalesce(left(p_error, 500), 'Google Drive connection check failed.') end,
      jsonb_build_object('status', v_status)
    );
  end if;
end;
$$;

-- User-initiated disconnect (permission re-checked here).
create function public.google_disconnect(p_store_id uuid, p_user_id uuid)
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
  return private.google_disconnect_internal(p_store_id, 'user', p_user_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants: service_role only
-- -----------------------------------------------------------------------------
revoke execute on function private.google_disconnect_internal(uuid, text, uuid) from public, anon, authenticated;

revoke execute on function
  public.google_begin_oauth(uuid, uuid, text, integer),
  public.google_consume_oauth_state(text),
  public.google_save_connection(uuid, uuid, uuid, text, text, text, text, text, timestamptz),
  public.google_get_credentials(uuid),
  public.google_store_refreshed_tokens(uuid, integer, text, text, timestamptz),
  public.google_record_verification(uuid, boolean, text, text, text, boolean),
  public.google_disconnect(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.google_begin_oauth(uuid, uuid, text, integer),
  public.google_consume_oauth_state(text),
  public.google_save_connection(uuid, uuid, uuid, text, text, text, text, text, timestamptz),
  public.google_get_credentials(uuid),
  public.google_store_refreshed_tokens(uuid, integer, text, text, timestamptz),
  public.google_record_verification(uuid, boolean, text, text, text, boolean),
  public.google_disconnect(uuid, uuid)
to service_role;
