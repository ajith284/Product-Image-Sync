-- =============================================================================
-- Prompt 8: secure machine-to-machine API for n8n.
--
--   internal.api_keys            hashed API credentials (never plaintext)
--   internal.api_request_nonces  replay protection for signed requests
--   internal.api_rate_limits     fixed-window counters (per key / workspace)
--   public.sync_jobs             EXTENDED (no new job table): workspace_id,
--                                queued/…/cancelled states, idempotency, progress
--
-- internal.* is not exposed by the Data API; anon/authenticated have no access.
-- All RPCs are SECURITY DEFINER, executable ONLY by service_role, and each one
-- re-checks the API key (active, scope, workspace, store restriction) itself.
-- No existing data is deleted.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. API keys
-- -----------------------------------------------------------------------------
create table internal.api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  store_id      uuid,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  -- Public identifier embedded in the token (pis_live_<12 chars>); safe to display.
  key_prefix    text not null unique check (key_prefix ~ '^pis_live_[a-z0-9]{12}$'),
  -- SHA-256 (hex) of the 256-bit random secret. The plaintext is never stored.
  secret_hash   text not null check (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes        text[] not null check (
                  cardinality(scopes) > 0
                  and scopes <@ array['n8n:read', 'n8n:sync', 'n8n:jobs']::text[]),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users (id) on delete set null,
  -- A store restriction must point at a store of the SAME workspace.
  constraint api_keys_store_fkey foreign key (store_id, workspace_id)
    references public.stores (id, workspace_id) on delete cascade
);
comment on table internal.api_keys is 'Product Image Sync API credentials (n8n). Only SHA-256 hashes of secrets. Server-only.';
create index api_keys_workspace_idx on internal.api_keys (workspace_id, created_at desc);
create index api_keys_store_idx on internal.api_keys (store_id, workspace_id);
create index api_keys_created_by_idx on internal.api_keys (created_by);
create index api_keys_revoked_by_idx on internal.api_keys (revoked_by);

create table internal.api_request_nonces (
  api_key_id  uuid not null references internal.api_keys (id) on delete cascade,
  nonce       text not null check (char_length(nonce) between 8 and 128),
  expires_at  timestamptz not null,
  primary key (api_key_id, nonce)
);
create index api_request_nonces_expires_idx on internal.api_request_nonces (expires_at);

create table internal.api_rate_limits (
  bucket        text not null check (char_length(bucket) <= 200),
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, window_start)
);
create index api_rate_limits_window_idx on internal.api_rate_limits (window_start);

alter table internal.api_keys enable row level security;
alter table internal.api_request_nonces enable row level security;
alter table internal.api_rate_limits enable row level security;
revoke all on internal.api_keys, internal.api_request_nonces, internal.api_rate_limits from public, anon, authenticated;
grant all on internal.api_keys, internal.api_request_nonces, internal.api_rate_limits to service_role;

-- -----------------------------------------------------------------------------
-- 2. sync_jobs: reuse + extend (states, workspace, idempotency, progress)
-- -----------------------------------------------------------------------------
alter table public.sync_jobs drop constraint sync_jobs_status_check;
update public.sync_jobs set status = 'queued' where status = 'pending';
update public.sync_jobs set status = 'completed_with_errors' where status = 'partially_completed';
alter table public.sync_jobs
  alter column status set default 'queued',
  add constraint sync_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'));

alter table public.sync_jobs drop constraint sync_jobs_trigger_type_check;
alter table public.sync_jobs
  add constraint sync_jobs_trigger_type_check check (trigger_type in ('manual', 'scheduled', 'n8n', 'api'));

alter table public.sync_jobs
  add column workspace_id          uuid,
  add column requested_by_user     uuid references auth.users (id) on delete set null,
  add column requested_by_api_key  uuid references internal.api_keys (id) on delete set null,
  add column idempotency_key       text check (char_length(idempotency_key) between 1 and 200),
  add column request_hash          text check (request_hash ~ '^[a-f0-9]{64}$'),
  add column request_id            text check (char_length(request_id) <= 100),
  add column dry_run               boolean not null default false,
  add column options               jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  add column items_total           integer not null default 0 check (items_total >= 0),
  add column items_skipped         integer not null default 0 check (items_skipped >= 0),
  add column items_review          integer not null default 0 check (items_review >= 0),
  add column items_failed          integer not null default 0 check (items_failed >= 0),
  add column cancel_requested_at   timestamptz,
  add column cancelled_at          timestamptz,
  add column error_code            text check (char_length(error_code) <= 100),
  add column error_message         text check (char_length(error_message) <= 500);

update public.sync_jobs j set workspace_id = s.workspace_id from public.stores s where s.id = j.store_id;
alter table public.sync_jobs
  alter column workspace_id set not null,
  add constraint sync_jobs_store_workspace_fkey foreign key (store_id, workspace_id)
    references public.stores (id, workspace_id) on delete cascade;

-- Existing inserts that only set store_id keep working: workspace_id is taken
-- from the store (the composite FK above still rejects any mismatch).
create function private.sync_jobs_set_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    select s.workspace_id into new.workspace_id from public.stores s where s.id = new.store_id;
  end if;
  return new;
end;
$$;
revoke execute on function private.sync_jobs_set_workspace() from public, anon, authenticated;
create trigger set_workspace before insert on public.sync_jobs
  for each row execute function private.sync_jobs_set_workspace();

comment on column public.sync_jobs.idempotency_key is 'Idempotency-Key from the API caller; unique per workspace.';
comment on column public.sync_jobs.cancel_requested_at is 'Set when cancellation was requested for a running job; the worker stops later.';

-- Idempotency is scoped to the workspace (never global).
create unique index sync_jobs_idempotency_key on public.sync_jobs (workspace_id, idempotency_key)
  where idempotency_key is not null;
-- At most one active (queued/running) job per store.
create unique index sync_jobs_one_active_per_store on public.sync_jobs (store_id)
  where status in ('queued', 'running');
create index sync_jobs_workspace_created_idx on public.sync_jobs (workspace_id, created_at desc, id desc);
create index sync_jobs_store_created_idx on public.sync_jobs (store_id, created_at desc, id desc);
create index sync_jobs_requested_by_user_idx on public.sync_jobs (requested_by_user);
create index sync_jobs_requested_by_api_key_idx on public.sync_jobs (requested_by_api_key);

-- -----------------------------------------------------------------------------
-- 3. Private helpers
-- -----------------------------------------------------------------------------

-- Validates an API key for one call. Raises:
--   invalid_api_key     missing / revoked / expired
--   insufficient_scope  scope not granted
--   store_not_found     store outside the key's workspace or store restriction
create function private.n8n_key_check(p_key_id uuid, p_scope text, p_store_id uuid default null)
returns internal.api_keys
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
begin
  select * into k from internal.api_keys
  where id = p_key_id and revoked_at is null and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'invalid_api_key';
  end if;
  if p_scope is not null and not (p_scope = any (k.scopes)) then
    raise exception 'insufficient_scope';
  end if;
  if p_store_id is not null then
    if k.store_id is not null and k.store_id <> p_store_id then
      raise exception 'store_not_found';
    end if;
    if not exists (select 1 from public.stores s where s.id = p_store_id and s.workspace_id = k.workspace_id) then
      raise exception 'store_not_found';
    end if;
  end if;
  return k;
end;
$$;

-- Safe JSON view of a job (never tokens / secrets).
create function private.n8n_job_json(j public.sync_jobs)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'job_id', j.id,
    'store_id', j.store_id,
    'status', j.status,
    'trigger_source', j.trigger_type,
    'dry_run', j.dry_run,
    'options', j.options,
    'cancel_requested', j.cancel_requested_at is not null,
    'progress', jsonb_build_object(
      'total', j.items_total,
      'processed', j.products_processed,
      'uploaded', j.images_uploaded,
      'skipped', j.items_skipped,
      'review', j.items_review,
      'failed', j.items_failed
    ),
    'counts', jsonb_build_object(
      'products_processed', j.products_processed,
      'products_synced', j.products_synced,
      'images_uploaded', j.images_uploaded,
      'warnings', j.warnings_count,
      'errors', j.errors_count
    ),
    'error', case when j.error_code is null then null
                  else jsonb_build_object('code', j.error_code, 'message', j.error_message) end,
    'created_at', j.created_at,
    'started_at', j.started_at,
    'completed_at', j.completed_at,
    'cancelled_at', j.cancelled_at
  );
$$;

-- -----------------------------------------------------------------------------
-- 4. Machine API RPCs (service_role only)
-- -----------------------------------------------------------------------------

-- Lookup by public prefix. Returns nothing for unknown / revoked / expired keys.
-- The app compares the secret hash in constant time.
create function public.n8n_authenticate(p_key_prefix text)
returns table (id uuid, workspace_id uuid, store_id uuid, scopes text[], secret_hash text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.workspace_id, k.store_id, k.scopes, k.secret_hash, k.name
  from internal.api_keys k
  where k.key_prefix = p_key_prefix and k.revoked_at is null and (k.expires_at is null or k.expires_at > now());
$$;

create function public.n8n_touch_api_key(p_key_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update internal.api_keys set last_used_at = now()
  where id = p_key_id and (last_used_at is null or last_used_at < now() - interval '1 minute');
$$;

-- Fixed-window counter. allowed=false once count > limit in the current window.
create function public.n8n_rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, current_count integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_window_seconds not between 1 and 3600 or p_limit < 1 then
    raise exception 'invalid_request';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into internal.api_rate_limits as r (bucket, window_start, count)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  if random() < 0.02 then
    delete from internal.api_rate_limits where window_start < now() - interval '1 hour';
  end if;

  return query select
    v_count <= p_limit,
    v_count,
    greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;

-- Records a signed request's nonce once. false = replay.
create function public.n8n_use_nonce(p_key_id uuid, p_nonce text, p_ttl_seconds integer default 600)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.n8n_key_check(p_key_id, null, null);
  delete from internal.api_request_nonces where api_key_id = p_key_id and expires_at < now();
  insert into internal.api_request_nonces (api_key_id, nonce, expires_at)
  values (p_key_id, p_nonce, now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 3600)))
  on conflict do nothing;
  return found;
end;
$$;

-- Safe store status (scope n8n:read).
create function public.n8n_store_status(p_key_id uuid, p_store_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.stores;
  sh public.shopify_connections;
  gd public.google_drive_connections;
  v_shop_ok boolean;
  v_drive_ok boolean;
begin
  perform private.n8n_key_check(p_key_id, 'n8n:read', p_store_id);
  select * into s from public.stores where id = p_store_id;
  select * into sh from public.shopify_connections where store_id = p_store_id;
  select * into gd from public.google_drive_connections where store_id = p_store_id;
  v_shop_ok := coalesce(sh.connection_status = 'connected', false);
  v_drive_ok := coalesce(gd.connection_status = 'connected', false);
  return jsonb_build_object(
    'store_id', s.id,
    'store_name', s.name,
    'shopify', jsonb_build_object(
      'connected', v_shop_ok,
      'status', coalesce(sh.connection_status, 'not_connected'),
      'shop_domain', coalesce(sh.shop_domain, s.shopify_domain),
      'last_verified_at', sh.last_verified_at),
    'google_drive', jsonb_build_object(
      'connected', v_drive_ok,
      'status', coalesce(gd.connection_status, 'not_connected'),
      'root_folder_selected', gd.root_folder_id is not null,
      'root_folder_id', gd.root_folder_id,
      'root_folder_name', gd.root_folder_name,
      'last_verified_at', gd.last_verified_at),
    'ready_for_sync', v_shop_ok and v_drive_ok and gd.root_folder_id is not null
  );
end;
$$;

-- Create (queue) a sync job. Idempotent per workspace + Idempotency-Key.
-- Raises: invalid_api_key, insufficient_scope, store_not_found, invalid_request,
--   idempotency_conflict, shopify_not_connected, google_drive_not_connected,
--   google_drive_root_not_selected, sync_job_already_active
create function public.n8n_create_sync_job(
  p_key_id uuid,
  p_store_id uuid,
  p_trigger text,
  p_dry_run boolean,
  p_options jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_request_id text
)
returns table (job jsonb, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
  j public.sync_jobs;
  v_active uuid;
begin
  k := private.n8n_key_check(p_key_id, 'n8n:sync', p_store_id);
  if p_trigger not in ('n8n', 'scheduled', 'api')
     or p_request_hash !~ '^[a-f0-9]{64}$'
     or (p_idempotency_key is not null and char_length(p_idempotency_key) not between 1 and 200)
     or jsonb_typeof(coalesce(p_options, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_request';
  end if;

  -- Replay of an earlier request with the same key (scoped to THIS workspace).
  if p_idempotency_key is not null then
    select * into j from public.sync_jobs
    where workspace_id = k.workspace_id and idempotency_key = p_idempotency_key;
    if found then
      if j.store_id = p_store_id and j.request_hash = p_request_hash then
        return query select private.n8n_job_json(j), true;
        return;
      end if;
      raise exception 'idempotency_conflict';
    end if;
  end if;

  -- Required integrations.
  if not exists (select 1 from public.shopify_connections c where c.store_id = p_store_id and c.connection_status = 'connected') then
    raise exception 'shopify_not_connected';
  end if;
  if not exists (select 1 from public.google_drive_connections c where c.store_id = p_store_id and c.connection_status = 'connected') then
    raise exception 'google_drive_not_connected';
  end if;
  if not exists (select 1 from public.google_drive_connections c where c.store_id = p_store_id and c.root_folder_id is not null) then
    raise exception 'google_drive_root_not_selected';
  end if;

  select id into v_active from public.sync_jobs where store_id = p_store_id and status in ('queued', 'running') limit 1;
  if v_active is not null then
    raise exception 'sync_job_already_active' using detail = v_active::text;
  end if;

  begin
    insert into public.sync_jobs (
      store_id, workspace_id, status, trigger_type, requested_by_api_key,
      idempotency_key, request_hash, request_id, dry_run, options
    )
    values (
      p_store_id, k.workspace_id, 'queued', p_trigger, k.id,
      p_idempotency_key, p_request_hash, left(p_request_id, 100), coalesce(p_dry_run, false), coalesce(p_options, '{}'::jsonb)
    )
    returning * into j;
  exception when unique_violation then
    -- A concurrent duplicate won the race: replay it, or report the conflict.
    if p_idempotency_key is not null then
      select * into j from public.sync_jobs where workspace_id = k.workspace_id and idempotency_key = p_idempotency_key;
      if found then
        if j.store_id = p_store_id and j.request_hash = p_request_hash then
          return query select private.n8n_job_json(j), true;
          return;
        end if;
        raise exception 'idempotency_conflict';
      end if;
    end if;
    select id into v_active from public.sync_jobs where store_id = p_store_id and status in ('queued', 'running') limit 1;
    raise exception 'sync_job_already_active' using detail = coalesce(v_active::text, '');
  end;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    k.workspace_id, p_store_id, 'sync_job_queued',
    format('Sync job queued via API key "%s"%s.', k.name, case when j.dry_run then ' (dry run)' else '' end),
    jsonb_build_object('job_id', j.id, 'api_key_id', k.id, 'request_id', left(p_request_id, 100), 'trigger', p_trigger)
  );

  return query select private.n8n_job_json(j), false;
end;
$$;

-- One job (scope n8n:jobs). Other workspace / store restriction → job_not_found.
create function public.n8n_get_sync_job(p_key_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
  j public.sync_jobs;
begin
  k := private.n8n_key_check(p_key_id, 'n8n:jobs', null);
  select * into j from public.sync_jobs
  where id = p_job_id and workspace_id = k.workspace_id and (k.store_id is null or store_id = k.store_id);
  if not found then
    raise exception 'job_not_found';
  end if;
  return private.n8n_job_json(j);
end;
$$;

-- Keyset-paginated list (newest first). Returns up to p_limit + 1 rows so the
-- caller can tell whether another page exists.
create function public.n8n_list_sync_jobs(
  p_key_id uuid,
  p_store_id uuid default null,
  p_status text default null,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
begin
  k := private.n8n_key_check(p_key_id, 'n8n:jobs', p_store_id);
  if p_limit not between 1 and 100 then
    raise exception 'invalid_request';
  end if;
  if p_status is not null and p_status not in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled') then
    raise exception 'invalid_request';
  end if;
  return query
    select private.n8n_job_json(j)
    from public.sync_jobs j
    where j.workspace_id = k.workspace_id
      and (k.store_id is null or j.store_id = k.store_id)
      and (p_store_id is null or j.store_id = p_store_id)
      and (p_status is null or j.status = p_status)
      and (p_cursor_created_at is null
           or (j.created_at, j.id) < (p_cursor_created_at, coalesce(p_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by j.created_at desc, j.id desc
    limit p_limit + 1;
end;
$$;

-- Cancel (idempotent). queued → cancelled; running → cancel requested.
create function public.n8n_cancel_sync_job(p_key_id uuid, p_job_id uuid, p_request_id text)
returns table (job jsonb, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
  j public.sync_jobs;
begin
  k := private.n8n_key_check(p_key_id, 'n8n:jobs', null);
  select * into j from public.sync_jobs
  where id = p_job_id and workspace_id = k.workspace_id and (k.store_id is null or store_id = k.store_id)
  for update;
  if not found then
    raise exception 'job_not_found';
  end if;

  if j.status = 'cancelled' or (j.status = 'running' and j.cancel_requested_at is not null) then
    return query select private.n8n_job_json(j), false;
    return;
  end if;
  if j.status not in ('queued', 'running') then
    raise exception 'job_not_cancellable';
  end if;

  if j.status = 'queued' then
    update public.sync_jobs
    set status = 'cancelled', cancel_requested_at = now(), cancelled_at = now(), completed_at = now()
    where id = j.id returning * into j;
  else
    update public.sync_jobs set cancel_requested_at = now() where id = j.id returning * into j;
  end if;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (
    k.workspace_id, j.store_id, 'sync_job_cancelled',
    case when j.status = 'cancelled' then format('Sync job cancelled via API key "%s".', k.name)
         else format('Cancellation requested for a running sync job via API key "%s".', k.name) end,
    jsonb_build_object('job_id', j.id, 'api_key_id', k.id, 'request_id', left(p_request_id, 100))
  );
  return query select private.n8n_job_json(j), true;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. API key management (called by the app after the user is authorized;
--    every function re-checks owner/admin of the workspace itself)
-- -----------------------------------------------------------------------------
create function public.api_keys_list(p_user_id uuid, p_workspace_id uuid)
returns table (
  id uuid, name text, key_prefix text, store_id uuid, store_name text, scopes text[],
  created_at timestamptz, last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden';
  end if;
  return query
    select k.id, k.name, k.key_prefix, k.store_id, s.name, k.scopes,
           k.created_at, k.last_used_at, k.expires_at, k.revoked_at
    from internal.api_keys k
    left join public.stores s on s.id = k.store_id
    where k.workspace_id = p_workspace_id
    order by k.revoked_at is not null, k.created_at desc;
end;
$$;

create function public.api_key_create(
  p_user_id uuid,
  p_workspace_id uuid,
  p_store_id uuid,
  p_name text,
  p_scopes text[],
  p_key_prefix text,
  p_secret_hash text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden';
  end if;
  if p_store_id is not null and not exists (
    select 1 from public.stores s where s.id = p_store_id and s.workspace_id = p_workspace_id
  ) then
    raise exception 'store_not_found';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'invalid_request';
  end if;
  if (select count(*) from internal.api_keys k where k.workspace_id = p_workspace_id and k.revoked_at is null) >= 25 then
    raise exception 'too_many_keys';
  end if;

  insert into internal.api_keys (workspace_id, store_id, name, key_prefix, secret_hash, scopes, created_by, expires_at)
  values (p_workspace_id, p_store_id, btrim(p_name), p_key_prefix, p_secret_hash,
          array(select distinct unnest(p_scopes) order by 1), p_user_id, p_expires_at)
  returning id into v_id;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (p_workspace_id, p_store_id, 'api_key_created', format('API key "%s" created.', btrim(p_name)),
          jsonb_build_object('api_key_id', v_id, 'key_prefix', p_key_prefix, 'scopes', p_scopes, 'actor', p_user_id));
  return v_id;
end;
$$;

create function public.api_key_revoke(p_user_id uuid, p_key_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
begin
  select * into k from internal.api_keys where id = p_key_id for update;
  if not found or not private.is_workspace_manager(p_user_id, k.workspace_id) then
    raise exception 'not_found';
  end if;
  if k.revoked_at is not null then
    return false;
  end if;
  update internal.api_keys set revoked_at = now(), revoked_by = p_user_id where id = p_key_id;
  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (k.workspace_id, k.store_id, 'api_key_revoked', format('API key "%s" revoked.', k.name),
          jsonb_build_object('api_key_id', k.id, 'key_prefix', k.key_prefix, 'actor', p_user_id));
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants: service_role only
-- -----------------------------------------------------------------------------
revoke execute on function
  private.n8n_key_check(uuid, text, uuid),
  private.n8n_job_json(public.sync_jobs)
from public, anon, authenticated;

revoke execute on function
  public.n8n_authenticate(text),
  public.n8n_touch_api_key(uuid),
  public.n8n_rate_limit_hit(text, integer, integer),
  public.n8n_use_nonce(uuid, text, integer),
  public.n8n_store_status(uuid, uuid),
  public.n8n_create_sync_job(uuid, uuid, text, boolean, jsonb, text, text, text),
  public.n8n_get_sync_job(uuid, uuid),
  public.n8n_list_sync_jobs(uuid, uuid, text, integer, timestamptz, uuid),
  public.n8n_cancel_sync_job(uuid, uuid, text),
  public.api_keys_list(uuid, uuid),
  public.api_key_create(uuid, uuid, uuid, text, text[], text, text, timestamptz),
  public.api_key_revoke(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.n8n_authenticate(text),
  public.n8n_touch_api_key(uuid),
  public.n8n_rate_limit_hit(text, integer, integer),
  public.n8n_use_nonce(uuid, text, integer),
  public.n8n_store_status(uuid, uuid),
  public.n8n_create_sync_job(uuid, uuid, text, boolean, jsonb, text, text, text),
  public.n8n_get_sync_job(uuid, uuid),
  public.n8n_list_sync_jobs(uuid, uuid, text, integer, timestamptz, uuid),
  public.n8n_cancel_sync_job(uuid, uuid, text),
  public.api_keys_list(uuid, uuid),
  public.api_key_create(uuid, uuid, uuid, text, text[], text, text, timestamptz),
  public.api_key_revoke(uuid, uuid)
to service_role;
