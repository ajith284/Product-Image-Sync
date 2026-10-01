-- =============================================================================
-- Prompt 12 — multiple Google Drive CATEGORY roots per store
--
-- A store can connect several category-level folders ("Sofa image",
-- "Sofa bed image", …). Code folders (SOF-001 …) and product folders (Milano …)
-- below them are discovered by the scanner, never configured.
--
-- Smallest change: one table of connected category roots. The existing
-- google_drive_connections.root_folder_id / root_folder_name stay (Prompt 7 UI,
-- n8n readiness, Prompt 11 downloader) and always point at one of the roots
-- (the first one added) while any root exists for the connected account.
-- Existing selected roots are copied in (backfill). Members can read; only the
-- service-role functions below write, after checking workspace → owner/admin →
-- store → connected Google account.
-- =============================================================================

create table public.google_drive_category_roots (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores (id) on delete cascade,
  connection_id      uuid not null references public.google_drive_connections (id) on delete cascade,
  -- The Google account (OpenID sub) that selected the folder. Roots of a previously
  -- connected account are ignored by the scanner/downloader (never used).
  google_account_id  text not null check (char_length(google_account_id) between 1 and 255),
  folder_id          text not null check (folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_name        text not null check (char_length(btrim(folder_name)) between 1 and 500),
  added_by           uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint google_drive_category_roots_store_folder_key unique (store_id, folder_id)
);
comment on table public.google_drive_category_roots is
  'Category-level Drive folders connected to a store (e.g. "Sofa image"). The scanner discovers code and product folders below them.';
create index google_drive_category_roots_store_idx on public.google_drive_category_roots (store_id, created_at);
create index google_drive_category_roots_connection_idx on public.google_drive_category_roots (connection_id);
create index google_drive_category_roots_added_by_idx on public.google_drive_category_roots (added_by);

create trigger set_updated_at before update on public.google_drive_category_roots
  for each row execute function private.set_updated_at();

-- RLS: members of the store's workspace can read; nobody writes through the API.
alter table public.google_drive_category_roots enable row level security;
create policy "google_drive_category_roots: members read"
  on public.google_drive_category_roots for select to authenticated
  using (store_id in (select private.member_store_ids()));
revoke all on public.google_drive_category_roots from anon, authenticated;
grant select on public.google_drive_category_roots to authenticated;
grant all on public.google_drive_category_roots to service_role;

-- Backfill: every existing selected root becomes the store's first category root.
insert into public.google_drive_category_roots (store_id, connection_id, google_account_id, folder_id, folder_name)
select c.store_id, c.id, c.google_account_id, c.root_folder_id, coalesce(nullif(btrim(c.root_folder_name), ''), c.root_folder_id)
from public.google_drive_connections c
where c.root_folder_id is not null
  and c.google_account_id is not null
  and c.root_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'
on conflict (store_id, folder_id) do nothing;

-- -----------------------------------------------------------------------------
-- Add a category root (owner/admin; connection connected with the SAME Google
-- account that validated the folder). Idempotent per (store, folder).
-- Keeps google_drive_connections.root_folder_id set (first root) for existing code.
-- -----------------------------------------------------------------------------
create function public.google_add_category_root(
  p_store_id          uuid,
  p_workspace_id      uuid,
  p_user_id           uuid,
  p_google_account_id text,
  p_folder_id         text,
  p_folder_name       text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conn public.google_drive_connections;
  v_id   uuid;
begin
  if not exists (select 1 from public.stores s where s.id = p_store_id and s.workspace_id = p_workspace_id) then
    raise exception 'store_not_found' using errcode = 'P0002';
  end if;
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_folder_id is null or p_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception 'invalid_folder' using errcode = '22023';
  end if;

  select * into v_conn from public.google_drive_connections c
  where c.store_id = p_store_id
  for update;
  if not found or v_conn.connection_status <> 'connected' then
    raise exception 'google_not_connected' using errcode = 'P0002';
  end if;
  if v_conn.google_account_id is distinct from p_google_account_id then
    raise exception 'google_not_connected' using errcode = 'P0002'; -- account changed meanwhile
  end if;

  insert into public.google_drive_category_roots (store_id, connection_id, google_account_id, folder_id, folder_name, added_by)
  values (p_store_id, v_conn.id, p_google_account_id, p_folder_id, left(btrim(p_folder_name), 500), p_user_id)
  on conflict (store_id, folder_id) do update
    set connection_id = excluded.connection_id,
        google_account_id = excluded.google_account_id,
        folder_name = excluded.folder_name
  returning id into v_id;

  -- Keep the single-root columns pointing at a valid root of the current account.
  if v_conn.root_folder_id is null or not exists (
    select 1 from public.google_drive_category_roots r
    where r.store_id = p_store_id and r.folder_id = v_conn.root_folder_id and r.google_account_id = p_google_account_id
  ) then
    update public.google_drive_connections c
       set root_folder_id = p_folder_id, root_folder_name = left(btrim(p_folder_name), 500)
     where c.id = v_conn.id;
  end if;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (p_workspace_id, p_store_id, 'google_drive_category_root_added',
          format('Connected Google Drive category folder "%s".', left(btrim(p_folder_name), 200)),
          jsonb_build_object('folder_id', p_folder_id, 'actor', p_user_id));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Remove a category root (owner/admin). Only the configuration row is removed —
-- no Drive files, no sync history. If it was the root_folder_id, another root of
-- the same account takes its place (or null when none is left).
-- -----------------------------------------------------------------------------
create function public.google_remove_category_root(
  p_store_id     uuid,
  p_workspace_id uuid,
  p_user_id      uuid,
  p_folder_id    text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conn public.google_drive_connections;
  v_name text;
  v_next public.google_drive_category_roots;
begin
  if not exists (select 1 from public.stores s where s.id = p_store_id and s.workspace_id = p_workspace_id) then
    raise exception 'store_not_found' using errcode = 'P0002';
  end if;
  if not private.is_workspace_manager(p_user_id, p_workspace_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.google_drive_category_roots r
  where r.store_id = p_store_id and r.folder_id = p_folder_id
  returning r.folder_name into v_name;
  if not found then return false; end if;

  select * into v_conn from public.google_drive_connections c where c.store_id = p_store_id for update;
  if found and v_conn.root_folder_id = p_folder_id then
    select * into v_next from public.google_drive_category_roots r
    where r.store_id = p_store_id and r.google_account_id is not distinct from v_conn.google_account_id
    order by r.created_at, r.id
    limit 1;
    update public.google_drive_connections c
       set root_folder_id = v_next.folder_id, root_folder_name = v_next.folder_name
     where c.id = v_conn.id;
  end if;

  insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
  values (p_workspace_id, p_store_id, 'google_drive_category_root_removed',
          format('Disconnected Google Drive category folder "%s".', left(v_name, 200)),
          jsonb_build_object('folder_id', p_folder_id, 'actor', p_user_id));
  return true;
end;
$$;

revoke all on function
  public.google_add_category_root(uuid, uuid, uuid, text, text, text),
  public.google_remove_category_root(uuid, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.google_add_category_root(uuid, uuid, uuid, text, text, text),
  public.google_remove_category_root(uuid, uuid, uuid, text)
to service_role;
