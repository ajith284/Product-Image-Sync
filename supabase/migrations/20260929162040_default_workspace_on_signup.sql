-- =============================================================================
-- Sign-up onboarding: every new auth user gets
--   1. a profile row (full_name from sign-up form metadata — display only,
--      never used for authorization)
--   2. a default workspace named "My Workspace"
--   3. an owner membership in that workspace
-- all in the same transaction as the auth.users insert, so it works whether
-- or not email confirmation is enabled.
-- =============================================================================

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    nullif(left(btrim(new.raw_user_meta_data ->> 'full_name'), 200), ''),
    left(new.raw_user_meta_data ->> 'avatar_url', 2048)
  )
  on conflict (id) do nothing;

  insert into public.workspaces (name, created_by)
  values ('My Workspace', new.id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, new.id, 'owner');

  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

-- Backfill: existing users without any workspace get a default one.
do $$
declare
  u record;
  v_workspace_id uuid;
begin
  for u in
    select au.id from auth.users au
    where not exists (select 1 from public.workspace_members m where m.user_id = au.id)
  loop
    insert into public.workspaces (name, created_by) values ('My Workspace', u.id)
    returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role) values (v_workspace_id, u.id, 'owner');
  end loop;
end;
$$;
