-- =============================================================================
-- Prompt 13 — sync worker: claim / lease / heartbeat / progress / finish
--
-- Reuses sync_jobs, sync_items and sync_images (no new tables).
--   sync_jobs:  worker_id + claimed_at + heartbeat_at (one worker per job, lease
--               based crash recovery) and result (safe summary, incl. dry-run plan).
--   sync_items: one row per PRODUCT folder per job (unique), with where it was found
--               (category root / code folder) and the match candidates for review.
-- Every function re-checks workspace → job → store (→ worker lease) itself.
-- =============================================================================

alter table public.sync_jobs
  add column worker_id     text check (worker_id ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  add column claimed_at    timestamptz,
  add column heartbeat_at  timestamptz,
  add column result        jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object');
comment on column public.sync_jobs.worker_id is 'Worker that currently owns the job (lease renewed through heartbeat_at).';
comment on column public.sync_jobs.result is 'Safe summary written by the worker (counts, review items, dry-run plan). Never tokens or bytes.';

alter table public.sync_items
  add column category_root_id  text check (char_length(category_root_id) <= 200),
  add column code_folder_id    text check (char_length(code_folder_id) <= 200),
  add column code_folder_name  text check (char_length(code_folder_name) <= 500),
  add column match_candidates  jsonb not null default '[]'::jsonb check (jsonb_typeof(match_candidates) = 'array'),
  add column images_skipped    integer not null default 0 check (images_skipped >= 0),
  add column images_failed     integer not null default 0 check (images_failed >= 0);
comment on column public.sync_items.drive_folder_id is 'Drive PRODUCT folder (e.g. Milano) — the Shopify matching key.';
comment on column public.sync_items.match_candidates is 'Shopify products found for the product-folder name (all of them for multiple_matches). Never auto-selected.';

-- One item per product folder per job → a restarted worker updates, never duplicates.
create unique index sync_items_job_folder_key on public.sync_items (sync_job_id, drive_folder_id);

-- The job JSON returned by the n8n API now includes the worker's safe result.
create or replace function private.n8n_job_json(j public.sync_jobs)
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
    'result', j.result,
    'error', case when j.error_code is null then null
                  else jsonb_build_object('code', j.error_code, 'message', j.error_message) end,
    'created_at', j.created_at,
    'started_at', j.started_at,
    'completed_at', j.completed_at,
    'cancelled_at', j.cancelled_at
  );
$$;

-- -----------------------------------------------------------------------------
-- Claim (shared by the n8n endpoint and server-side callers)
--   queued                         → running (claimed)
--   running, lease expired         → re-claimed by the new worker (crash recovery)
--   running, lease alive           → not claimed ('already_running')
--   completed/failed/cancelled/…   → not claimed ('finished')
-- -----------------------------------------------------------------------------
create function private.sync_job_claim_row(p_job public.sync_jobs, p_worker_id text, p_lease_seconds integer)
returns table (job public.sync_jobs, claimed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs := p_job;
begin
  if p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9_.:-]{8,100}$' then
    raise exception 'invalid_worker_id' using errcode = '22023';
  end if;
  if j.status = 'queued' then
    update public.sync_jobs
       set status = 'running', worker_id = p_worker_id, claimed_at = now(), heartbeat_at = now(),
           started_at = coalesce(started_at, now())
     where id = j.id returning * into j;
    return query select j, true, 'claimed'::text;
  elsif j.status = 'running'
        and (j.heartbeat_at is null or j.heartbeat_at < now() - make_interval(secs => greatest(p_lease_seconds, 60))) then
    update public.sync_jobs
       set worker_id = p_worker_id, claimed_at = now(), heartbeat_at = now()
     where id = j.id returning * into j;
    return query select j, true, 'reclaimed'::text;
  elsif j.status = 'running' then
    return query select j, false, 'already_running'::text;
  else
    return query select j, false, 'finished'::text;
  end if;
end;
$$;

-- n8n: POST /sync-jobs/{jobId}/run — API key (scope n8n:sync) → workspace → store restriction → job.
create function public.n8n_start_sync_job(
  p_key_id uuid, p_job_id uuid, p_request_id text, p_worker_id text, p_lease_seconds integer default 900
)
returns table (job jsonb, claimed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k internal.api_keys;
  j public.sync_jobs;
  c record;
begin
  k := private.n8n_key_check(p_key_id, 'n8n:sync', null);
  select * into j from public.sync_jobs
  where id = p_job_id and workspace_id = k.workspace_id and (k.store_id is null or store_id = k.store_id)
  for update;
  if not found then
    raise exception 'job_not_found';
  end if;
  select * into c from private.sync_job_claim_row(j, p_worker_id, p_lease_seconds);
  if c.claimed then
    insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
    values (k.workspace_id, j.store_id, 'sync_job_started',
            case when c.reason = 'reclaimed' then 'Sync job restarted by a new worker (previous worker stopped responding).'
                 else format('Sync job started via API key "%s".', k.name) end,
            jsonb_build_object('job_id', j.id, 'api_key_id', k.id, 'request_id', left(p_request_id, 100), 'dry_run', (c.job).dry_run));
  end if;
  return query select private.n8n_job_json(c.job), c.claimed, c.reason;
end;
$$;

-- Server-side claim (worker started without the n8n endpoint). Workspace must own the job.
create function public.sync_job_claim(p_workspace_id uuid, p_job_id uuid, p_worker_id text, p_lease_seconds integer default 900)
returns table (job jsonb, claimed boolean, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs; c record;
begin
  select * into j from public.sync_jobs where id = p_job_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  select * into c from private.sync_job_claim_row(j, p_worker_id, p_lease_seconds);
  return query select private.n8n_job_json(c.job), c.claimed, c.reason;
end;
$$;

-- Lease check for the worker: workspace → job → still owned by this worker and running.
create function private.sync_job_owned(p_workspace_id uuid, p_job_id uuid, p_worker_id text)
returns public.sync_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs;
begin
  select * into j from public.sync_jobs
  where id = p_job_id and workspace_id = p_workspace_id
  for update;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  if j.status <> 'running' or j.worker_id is distinct from p_worker_id then
    raise exception 'job_not_owned' using errcode = 'P0001';
  end if;
  return j;
end;
$$;

-- Progress + heartbeat. Returns whether cancellation was requested.
create function public.sync_job_heartbeat(p_workspace_id uuid, p_job_id uuid, p_worker_id text, p_progress jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs;
begin
  j := private.sync_job_owned(p_workspace_id, p_job_id, p_worker_id);
  update public.sync_jobs set
    heartbeat_at       = now(),
    items_total        = coalesce((p_progress->>'total')::int, items_total),
    products_processed = coalesce((p_progress->>'processed')::int, products_processed),
    images_uploaded    = coalesce((p_progress->>'uploaded')::int, images_uploaded),
    items_skipped      = coalesce((p_progress->>'skipped')::int, items_skipped),
    items_review       = coalesce((p_progress->>'review')::int, items_review),
    items_failed       = coalesce((p_progress->>'failed')::int, items_failed),
    products_synced    = coalesce((p_progress->>'synced')::int, products_synced),
    warnings_count     = coalesce((p_progress->>'warnings')::int, warnings_count),
    errors_count       = coalesce((p_progress->>'errors')::int, errors_count)
  where id = j.id
  returning * into j;
  return jsonb_build_object('cancel_requested', j.cancel_requested_at is not null, 'store_id', j.store_id, 'dry_run', j.dry_run);
end;
$$;

-- Terminal state. Only the owning worker can finish a running job.
create function public.sync_job_finish(
  p_workspace_id uuid, p_job_id uuid, p_worker_id text, p_status text,
  p_error_code text, p_error_message text, p_progress jsonb, p_result jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs;
begin
  if p_status not in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'invalid_error' using errcode = '22023';
  end if;
  perform public.sync_job_heartbeat(p_workspace_id, p_job_id, p_worker_id, p_progress);
  update public.sync_jobs set
    status        = p_status,
    completed_at  = now(),
    cancelled_at  = case when p_status = 'cancelled' then now() else cancelled_at end,
    error_code    = p_error_code,
    error_message = left(p_error_message, 500),
    result        = coalesce(p_result, '{}'::jsonb),
    worker_id     = null
  where id = p_job_id and workspace_id = p_workspace_id
  returning * into j;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (p_workspace_id, j.store_id, 'sync_job_finished',
          format('Sync job %s%s: %s product folder(s), %s image(s) uploaded, %s skipped, %s for review, %s failed.',
                 replace(p_status, '_', ' '), case when j.dry_run then ' (dry run)' else '' end,
                 j.products_processed, j.images_uploaded, j.items_skipped, j.items_review, j.items_failed),
          jsonb_build_object('job_id', j.id, 'status', p_status, 'error_code', p_error_code));
  return private.n8n_job_json(j);
end;
$$;

-- Record one PRODUCT folder for the job (idempotent per job + folder).
create function public.sync_item_record(p_workspace_id uuid, p_job_id uuid, p_worker_id text, p_item jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs; v_id uuid;
begin
  j := private.sync_job_owned(p_workspace_id, p_job_id, p_worker_id);
  insert into public.sync_items (
    sync_job_id, store_id, drive_folder_id, drive_folder_name, category_root_id, code_folder_id, code_folder_name,
    shopify_product_id, shopify_product_title, product_status, status, images_found, match_candidates, error_message
  ) values (
    j.id, j.store_id, p_item->>'drive_folder_id', left(p_item->>'drive_folder_name', 500), p_item->>'category_root_id',
    p_item->>'code_folder_id', left(p_item->>'code_folder_name', 500),
    p_item->>'shopify_product_id', left(p_item->>'shopify_product_title', 500), p_item->>'product_status',
    p_item->>'status', coalesce((p_item->>'images_found')::int, 0), coalesce(p_item->'match_candidates', '[]'::jsonb),
    left(p_item->>'error_message', 2000)
  )
  on conflict (sync_job_id, drive_folder_id) do update set
    drive_folder_name     = excluded.drive_folder_name,
    shopify_product_id    = excluded.shopify_product_id,
    shopify_product_title = excluded.shopify_product_title,
    product_status        = excluded.product_status,
    status                = excluded.status,
    images_found          = excluded.images_found,
    match_candidates      = excluded.match_candidates,
    error_message         = excluded.error_message
  returning id into v_id;
  return v_id;
end;
$$;

create function public.sync_item_update(
  p_workspace_id uuid, p_job_id uuid, p_worker_id text, p_item_id uuid,
  p_status text, p_images_uploaded integer, p_images_skipped integer, p_images_failed integer, p_error_message text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare j public.sync_jobs;
begin
  j := private.sync_job_owned(p_workspace_id, p_job_id, p_worker_id);
  update public.sync_items set
    status = p_status,
    images_uploaded = greatest(p_images_uploaded, 0),
    images_skipped = greatest(p_images_skipped, 0),
    images_failed = greatest(p_images_failed, 0),
    error_message = left(p_error_message, 2000)
  where id = p_item_id and sync_job_id = j.id and store_id = j.store_id;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
end;
$$;

-- Grants: service role only.
revoke all on function
  private.sync_job_claim_row(public.sync_jobs, text, integer),
  private.sync_job_owned(uuid, uuid, text)
from public, anon, authenticated;

revoke all on function
  public.n8n_start_sync_job(uuid, uuid, text, text, integer),
  public.sync_job_claim(uuid, uuid, text, integer),
  public.sync_job_heartbeat(uuid, uuid, text, jsonb),
  public.sync_job_finish(uuid, uuid, text, text, text, text, jsonb, jsonb),
  public.sync_item_record(uuid, uuid, text, jsonb),
  public.sync_item_update(uuid, uuid, text, uuid, text, integer, integer, integer, text)
from public, anon, authenticated;

grant execute on function
  public.n8n_start_sync_job(uuid, uuid, text, text, integer),
  public.sync_job_claim(uuid, uuid, text, integer),
  public.sync_job_heartbeat(uuid, uuid, text, jsonb),
  public.sync_job_finish(uuid, uuid, text, text, text, text, jsonb, jsonb),
  public.sync_item_record(uuid, uuid, text, jsonb),
  public.sync_item_update(uuid, uuid, text, uuid, text, integer, integer, integer, text)
to service_role;
