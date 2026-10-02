-- =============================================================================
-- Prompt 14F — Shopify mandatory compliance webhook: shop/redact
--
-- Shopify (privacy-law compliance docs, checked 2026-10-02): 48 hours after a store owner
-- uninstalls the app, Shopify sends shop/redact "so that you can erase data for that store
-- from your database"; respond 2xx and complete within 30 days.
--
-- What this app holds per Shopify shop, and what happens to it here:
--   shopify_connections row + internal.integration_secrets (tokens)  → deleted
--   internal.oauth_states for the shop                                → deleted
--   product_mappings (Shopify product ids / titles)                   → deleted
--   sync_images (Shopify product / media ids, the upload ledger)      → deleted
--   sync_items Shopify fields (product id / title / status / match_candidates) → nulled / emptied
--   sync_jobs.result review_items (contain Shopify candidates)        → removed from the result
-- Kept: the merchant's Product Image Sync store, its Google Drive connection, job counts,
-- Drive folder names, and the activity log (no Shopify customer data). The app never
-- requests customer scopes, so there is no customer data to erase.
--
-- Safety: only stores whose connection for THIS shop domain is disconnected (or already
-- gone) are touched — if the shop reinstalled and is connected again, nothing is erased.
-- Idempotent: duplicate deliveries (same webhook id) do nothing; a second redact for the
-- same shop finds nothing left to erase.
-- =============================================================================

create function public.shopify_handle_shop_redact(p_webhook_id text, p_shop_domain text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_store record;
  v_erased int := 0;
  v_rows int;
  v_changed int;
  v_result text;
begin
  if p_shop_domain is null or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'invalid_request';
  end if;
  if not public.shopify_record_webhook(p_webhook_id, 'shop/redact', p_shop_domain) then
    return 'duplicate';
  end if;

  -- Reinstalled and connected again → this redact is stale for the live connection.
  if exists (select 1 from public.shopify_connections c
             where c.shop_domain = p_shop_domain and c.connection_status <> 'disconnected') then
    v_result := 'skipped_connected';
  else
    for v_store in
      select s.id, s.workspace_id
      from public.stores s
      where s.id in (select c.store_id from public.shopify_connections c where c.shop_domain = p_shop_domain)
         or (s.shopify_domain = p_shop_domain
             and not exists (select 1 from public.shopify_connections c2 where c2.store_id = s.id))
      for update
    loop
      v_changed := 0;
      delete from internal.integration_secrets
      where provider = 'shopify'
        and connection_id in (select c.id from public.shopify_connections c where c.store_id = v_store.id);
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      delete from public.shopify_connections where store_id = v_store.id and shop_domain = p_shop_domain;
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      delete from public.product_mappings where store_id = v_store.id;
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      delete from public.sync_images where store_id = v_store.id;
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      update public.sync_items
         set shopify_product_id = null, shopify_product_title = null, product_status = null,
             match_candidates = '[]'::jsonb
       where store_id = v_store.id
         and (shopify_product_id is not null or shopify_product_title is not null
              or product_status is not null or match_candidates <> '[]'::jsonb);
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      update public.sync_jobs
         set result = result - 'review_items'
       where store_id = v_store.id and result ? 'review_items';
      get diagnostics v_rows = row_count; v_changed := v_changed + v_rows;
      if v_changed > 0 then
        insert into public.activity_logs (workspace_id, store_id, event_type, message, metadata)
        values (v_store.workspace_id, v_store.id, 'shopify_shop_redacted',
                'Shopify data for this store was erased at Shopify''s request (shop/redact).',
                jsonb_build_object('shop_domain', p_shop_domain, 'webhook_id', left(p_webhook_id, 200)));
        v_erased := v_erased + 1;
      end if;
    end loop;
    delete from internal.oauth_states where provider = 'shopify' and shop_domain = p_shop_domain;
    v_result := case when v_erased > 0 then 'redacted' else 'nothing_to_redact' end;
  end if;

  update internal.webhook_events set processed_at = now(), result = v_result where webhook_id = p_webhook_id;
  return v_result;
end;
$$;

revoke all on function public.shopify_handle_shop_redact(text, text) from public, anon, authenticated;
grant execute on function public.shopify_handle_shop_redact(text, text) to service_role;
