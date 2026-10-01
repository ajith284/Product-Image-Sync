-- =============================================================================
-- Prompt 10B — Shopify media upload: safe upload / retry state on sync_images
--
-- Extends the EXISTING per-image ledger (no new table). All existing columns,
-- data, the unique key (store_id, shopify_product_id, drive_file_id), RLS and
-- grants are kept. Users keep read-only access; every write goes through the
-- service-role-only sync_image_* functions below, which re-check
-- workspace → store → sync item / image themselves.
--
-- upload_status lifecycle:
--   pending     claimed, nothing created in Shopify yet
--   processing  Shopify file (MediaImage) created; shopify_media_id is set;
--               waiting for READY / attaching it to the product
--   uploaded    attached to the product (final)
--   failed      see error_code / retryable
--   skipped     (existing value, kept)
-- =============================================================================

-- 1. New status ------------------------------------------------------------------
alter table public.sync_images drop constraint sync_images_upload_status_check;
alter table public.sync_images add constraint sync_images_upload_status_check
  check (upload_status in ('pending', 'processing', 'uploaded', 'failed', 'skipped'));

-- 2. New columns (all nullable or defaulted → existing rows stay valid) ----------
alter table public.sync_images
  add column error_code       text    check (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  add column error_message    text    check (char_length(error_message) <= 1000),
  add column attempt_count    integer not null default 0 check (attempt_count >= 0),
  add column last_attempt_at  timestamptz,
  add column retryable        boolean,
  add column drive_folder_id  text    check (char_length(drive_folder_id) between 1 and 200),
  add column mime_type        text    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic')),
  add column file_size        bigint  check (file_size > 0 and file_size <= 20971520);

-- A file in "processing" must know which Shopify media it is waiting for: this is
-- what stops a retry from creating a second media for the same Drive file.
alter table public.sync_images add constraint sync_images_processing_has_media
  check (upload_status <> 'processing' or shopify_media_id is not null);
alter table public.sync_images add constraint sync_images_media_id_format
  check (shopify_media_id is null or shopify_media_id ~ '^gid://shopify/MediaImage/[0-9]{1,20}$') not valid;

comment on column public.sync_images.error_code is 'Upload error code (e.g. PRODUCT_NOT_FOUND, SHOPIFY_THROTTLED). Never contains secrets.';
comment on column public.sync_images.retryable is 'For failed rows: true = a later attempt may succeed; false = permanent, not retried unless the Drive file changes.';
comment on column public.sync_images.drive_folder_id is 'Drive product folder the file was found in (part of the duplicate key documented in docs/image-sync-rules.md).';

create index sync_images_store_status_idx on public.sync_images (store_id, upload_status);

-- 3. Service-role functions --------------------------------------------------------

-- Every function: the store must belong to the workspace; the image row (and
-- sync item, when given) must belong to the store. Raises store_not_found /
-- sync_item_not_found / image_not_found otherwise (same message for "other
-- workspace" and "doesn't exist").
create function private.sync_image_check_store(p_workspace_id uuid, p_store_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_workspace_id is null or p_store_id is null or not exists (
    select 1 from public.stores s where s.id = p_store_id and s.workspace_id = p_workspace_id
  ) then
    raise exception 'store_not_found' using errcode = 'P0002';
  end if;
end;
$$;

create function private.sync_image_json(i public.sync_images)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id,
    'store_id', i.store_id,
    'sync_item_id', i.sync_item_id,
    'shopify_product_id', i.shopify_product_id,
    'drive_file_id', i.drive_file_id,
    'drive_folder_id', i.drive_folder_id,
    'filename', i.filename,
    'checksum', i.checksum,
    'drive_modified_at', i.drive_modified_at,
    'mime_type', i.mime_type,
    'file_size', i.file_size,
    'shopify_media_id', i.shopify_media_id,
    'upload_status', i.upload_status,
    'uploaded_at', i.uploaded_at,
    'error_code', i.error_code,
    'error_message', i.error_message,
    'retryable', i.retryable,
    'attempt_count', i.attempt_count,
    'last_attempt_at', i.last_attempt_at
  );
$$;

/*
  Claim one Drive file for one Shopify product (duplicate protection).
  Key: (store_id, shopify_product_id, drive_file_id) — never the filename.
  "changed" = checksum differs (both known), else drive_modified_at differs (both known).

  Returns { action, image }:
    upload  – start a new upload (row is pending)
    resume  – a Shopify media already exists (processing, or a retryable failure
              after it was created): wait for / attach THAT media, never create another
    skip    – already uploaded and unchanged
    busy    – another worker claimed it less than p_lease_seconds ago
    blocked – permanent failure (or attempts exhausted) and the file is unchanged
*/
create function public.sync_image_claim(
  p_workspace_id       uuid,
  p_store_id           uuid,
  p_sync_item_id       uuid,
  p_shopify_product_id text,
  p_drive_file_id      text,
  p_drive_folder_id    text,
  p_filename           text,
  p_checksum           text,
  p_drive_modified_at  timestamptz,
  p_mime_type          text,
  p_file_size          bigint,
  p_lease_seconds      integer default 900,
  p_max_attempts       integer default 5
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row     public.sync_images;
  v_changed boolean;
  v_action  text;
begin
  perform private.sync_image_check_store(p_workspace_id, p_store_id);

  if p_sync_item_id is not null and not exists (
    select 1 from public.sync_items si where si.id = p_sync_item_id and si.store_id = p_store_id
  ) then
    raise exception 'sync_item_not_found' using errcode = 'P0002';
  end if;
  if p_shopify_product_id is null or p_shopify_product_id !~ '^gid://shopify/Product/[0-9]{1,20}$' then
    raise exception 'invalid_product_id' using errcode = '22023';
  end if;
  if p_drive_file_id is null or p_drive_file_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'invalid_drive_file_id' using errcode = '22023';
  end if;
  if p_filename is null or char_length(btrim(p_filename)) not between 1 and 255 then
    raise exception 'invalid_filename' using errcode = '22023';
  end if;

  select * into v_row
  from public.sync_images i
  where i.store_id = p_store_id
    and i.shopify_product_id = p_shopify_product_id
    and i.drive_file_id = p_drive_file_id
  for update;

  if not found then
    begin
      insert into public.sync_images (
        store_id, sync_item_id, shopify_product_id, drive_file_id, drive_folder_id, filename,
        checksum, drive_modified_at, mime_type, file_size, upload_status, last_attempt_at
      ) values (
        p_store_id, p_sync_item_id, p_shopify_product_id, p_drive_file_id, p_drive_folder_id, btrim(p_filename),
        p_checksum, p_drive_modified_at, p_mime_type, p_file_size, 'pending', now()
      )
      returning * into v_row;
      return jsonb_build_object('action', 'upload', 'image', private.sync_image_json(v_row));
    exception when unique_violation then
      -- Concurrent claim of the same file: the other worker owns it.
      select * into v_row from public.sync_images i
      where i.store_id = p_store_id and i.shopify_product_id = p_shopify_product_id
        and i.drive_file_id = p_drive_file_id;
      return jsonb_build_object('action', 'busy', 'image', private.sync_image_json(v_row));
    end;
  end if;

  v_changed := case
    when p_checksum is not null and v_row.checksum is not null then p_checksum <> v_row.checksum
    when p_drive_modified_at is not null and v_row.drive_modified_at is not null
      then p_drive_modified_at <> v_row.drive_modified_at
    else false
  end;

  if v_row.upload_status = 'uploaded' and not v_changed then
    v_action := 'skip';
  elsif v_row.upload_status = 'processing' then
    v_action := 'resume';                    -- never create a second media
  elsif v_row.upload_status = 'pending'
        and v_row.last_attempt_at is not null
        and v_row.last_attempt_at > now() - make_interval(secs => greatest(p_lease_seconds, 0)) then
    v_action := 'busy';
  elsif v_row.upload_status = 'failed' and not v_changed
        and (coalesce(v_row.retryable, false) = false or v_row.attempt_count >= p_max_attempts) then
    v_action := 'blocked';
  elsif v_row.upload_status = 'failed' and not v_changed and v_row.shopify_media_id is not null then
    v_action := 'resume';                    -- media was created before the retryable failure
  else
    v_action := 'upload';                    -- new content, retryable failure, stale pending, skipped
  end if;

  if v_action in ('upload', 'resume') then
    update public.sync_images i set
      sync_item_id      = coalesce(p_sync_item_id, i.sync_item_id),
      drive_folder_id   = coalesce(p_drive_folder_id, i.drive_folder_id),
      filename          = btrim(p_filename),
      checksum          = coalesce(p_checksum, i.checksum),
      drive_modified_at = coalesce(p_drive_modified_at, i.drive_modified_at),
      mime_type         = coalesce(p_mime_type, i.mime_type),
      file_size         = coalesce(p_file_size, i.file_size),
      -- A changed file starts over: the previous media stays on the product (never deleted).
      shopify_media_id  = case when v_action = 'upload' then null else i.shopify_media_id end,
      upload_status     = case when v_action = 'upload' then 'pending' else 'processing' end,
      uploaded_at       = case when v_action = 'upload' then null else i.uploaded_at end,
      attempt_count     = case when v_changed then 0 else i.attempt_count end,
      last_attempt_at   = now()
    where i.id = v_row.id
    returning * into v_row;
  end if;

  return jsonb_build_object('action', v_action, 'image', private.sync_image_json(v_row));
end;
$$;

-- Count one attempt (called once per upload/resume after a successful claim).
create function public.sync_image_record_attempt(p_workspace_id uuid, p_store_id uuid, p_image_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.sync_images;
begin
  perform private.sync_image_check_store(p_workspace_id, p_store_id);
  update public.sync_images i
     set attempt_count = i.attempt_count + 1, last_attempt_at = now()
   where i.id = p_image_id and i.store_id = p_store_id
  returning * into v_row;
  if not found then raise exception 'image_not_found' using errcode = 'P0002'; end if;
  return private.sync_image_json(v_row);
end;
$$;

-- Persist the Shopify media ID as soon as fileCreate returns it.
create function public.sync_image_mark_processing(
  p_workspace_id uuid, p_store_id uuid, p_image_id uuid, p_shopify_media_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.sync_images;
begin
  perform private.sync_image_check_store(p_workspace_id, p_store_id);
  if p_shopify_media_id is null or p_shopify_media_id !~ '^gid://shopify/MediaImage/[0-9]{1,20}$' then
    raise exception 'invalid_media_id' using errcode = '22023';
  end if;
  update public.sync_images i
     set upload_status = 'processing', shopify_media_id = p_shopify_media_id,
         error_code = null, error_message = null, retryable = null
   where i.id = p_image_id and i.store_id = p_store_id
     and i.upload_status in ('pending', 'processing', 'failed')
     and (i.shopify_media_id is null or i.shopify_media_id = p_shopify_media_id)
  returning * into v_row;
  if not found then raise exception 'image_not_found' using errcode = 'P0002'; end if;
  return private.sync_image_json(v_row);
end;
$$;

create function public.sync_image_mark_uploaded(
  p_workspace_id uuid, p_store_id uuid, p_image_id uuid, p_shopify_media_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.sync_images;
begin
  perform private.sync_image_check_store(p_workspace_id, p_store_id);
  update public.sync_images i
     set upload_status = 'uploaded', uploaded_at = now(),
         error_code = null, error_message = null, retryable = null
   where i.id = p_image_id and i.store_id = p_store_id
     and i.shopify_media_id = p_shopify_media_id
     and i.upload_status in ('processing', 'uploaded')
  returning * into v_row;
  if not found then raise exception 'image_not_found' using errcode = 'P0002'; end if;
  return private.sync_image_json(v_row);
end;
$$;

create function public.sync_image_mark_failed(
  p_workspace_id uuid, p_store_id uuid, p_image_id uuid,
  p_error_code text, p_error_message text, p_retryable boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.sync_images;
begin
  perform private.sync_image_check_store(p_workspace_id, p_store_id);
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,63}$' or p_retryable is null then
    raise exception 'invalid_error' using errcode = '22023';
  end if;
  update public.sync_images i
     set upload_status = 'failed',
         error_code = p_error_code,
         error_message = left(coalesce(p_error_message, ''), 1000),
         retryable = p_retryable
   where i.id = p_image_id and i.store_id = p_store_id
     and i.upload_status <> 'uploaded'
  returning * into v_row;
  if not found then raise exception 'image_not_found' using errcode = 'P0002'; end if;
  return private.sync_image_json(v_row);
end;
$$;

-- 4. Grants: service role only -----------------------------------------------------
revoke all on function
  private.sync_image_check_store(uuid, uuid),
  private.sync_image_json(public.sync_images)
from public, anon, authenticated;

revoke all on function
  public.sync_image_claim(uuid, uuid, uuid, text, text, text, text, text, timestamptz, text, bigint, integer, integer),
  public.sync_image_record_attempt(uuid, uuid, uuid),
  public.sync_image_mark_processing(uuid, uuid, uuid, text),
  public.sync_image_mark_uploaded(uuid, uuid, uuid, text),
  public.sync_image_mark_failed(uuid, uuid, uuid, text, text, boolean)
from public, anon, authenticated;

grant execute on function
  public.sync_image_claim(uuid, uuid, uuid, text, text, text, text, text, timestamptz, text, bigint, integer, integer),
  public.sync_image_record_attempt(uuid, uuid, uuid),
  public.sync_image_mark_processing(uuid, uuid, uuid, text),
  public.sync_image_mark_uploaded(uuid, uuid, uuid, text),
  public.sync_image_mark_failed(uuid, uuid, uuid, text, text, boolean)
to service_role;
