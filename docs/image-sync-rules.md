# Image sync rules — matching & duplicate protection

Rules the future image sync (Prompt 11) must follow. Matching is implemented
now (Prompt 5); duplicate protection is documented here and built in Prompt 11.
Source of truth: `PROJECT_SPEC.md` §6–§7.

## 1. Product matching (implemented)

Code: `lib/matching/product-match.ts` (pure) · `lib/shopify/products.ts` (Shopify search).

| Step | Rule |
|---|---|
| Source | The **Google Drive product folder name** (e.g. `Milano`). The `SOF-001` organisation folder is never matched. **SKU is never used.** |
| Manual mapping | `product_mappings` for `(store_id, drive_folder_id)` always wins (Prompt 11 applies it before searching). |
| Normalize | Unicode NFC → lowercase → trim → collapse whitespace runs (incl. tabs / non-breaking spaces) to one space. Punctuation and digits are kept. Only used for comparing; Shopify titles are never changed. |
| Match | normalized product title **contains** normalized folder name: `milano` ⊂ `milano 3 seater sofa`. |
| Statuses | ACTIVE, DRAFT, ARCHIVED and UNLISTED are all searched. Status is displayed only, never changed. |

| Matches | `classifyMatches()` status | Sync behaviour (Prompt 11) |
|---|---|---|
| 0 | `no_product_found` | Review Center. Never create a product. |
| 1 | `single_match` | Upload to that product. |
| 2+ | `multiple_matches` | Review Center, **upload nothing**. The user picks; the choice is saved to `product_mappings` and used first on every future sync. |

How the Shopify search works: Shopify's search is word-based, so we first fetch
candidates with `title:<word>* AND … AND status:active,archived,draft,unlisted`
(each word of the name as a prefix), then apply the exact "contains" rule in
code. Consequences:
- A name only matches when it starts at a word start in the title
  (`Milano` finds `Milano 3 Seater Sofa` and `The Milano Sofa`, but not `SuperMilano`).
- "Contains" is a substring rule: `Roma` also matches `Romance Chair`.
  That is by design (spec) — such cases become `multiple_matches` and go to review.
- Up to 500 candidates are scanned per search (`truncated: true` beyond that).
  For whole-store sync runs Prompt 11 may instead load all product titles once
  per job and call `matchFolderToProducts()` locally for every folder.
- `store_settings.matching_mode` (`contains` / `exact`) and the
  `case_insensitive` / `trim_spaces` flags exist in the DB but are not applied
  yet; current behaviour = contains + case-insensitive + trimmed (the defaults).

## 2. Duplicate protection (for Prompt 11)

**Duplicate detection is NOT based on filename alone.**

❌ Wrong: "`image-01.jpg` exists anywhere → skip".

✅ Correct — an image is identified by:

```
Shopify product ID + Drive folder ID + Drive file ID  (+ checksum / modified time to detect changes)
```

| Case | Example | Result |
|---|---|---|
| Same filename, different products | `Roma Sofa/image-01.jpg` and `Minor Sofa/image-01.jpg` | **Both upload** (different product + folder + file IDs). |
| Same product, same file, unchanged | `Roma Sofa/image-01.jpg`, same checksum/modified time as the recorded upload | **Skip** ("already uploaded"). |
| Same product, same file, changed | `Roma Sofa/image-01.jpg`, checksum (or modified time when no checksum) differs | **Upload the updated version.** |
| New file in folder | `image-04.jpg` added | Upload only `image-04.jpg`. |
| Folder re-mapped to another product | mapping changed | Uploads to the new product (new product ID); the old product's images are never deleted. |

Change detection: prefer Drive's `md5Checksum` (present for binary files);
fall back to `modifiedTime` when no checksum is available.

Never delete existing Shopify images automatically. For a changed file, add
the new version; replacing/removing the previous media is a separate, explicit
decision for Prompt 11 (default: add only).

### Schema notes for Prompt 11
- `sync_images` has `shopify_product_id`, `drive_file_id`, `filename`,
  `checksum`, `drive_modified_at`, `shopify_media_id`, `upload_status`, with
  `UNIQUE (store_id, shopify_product_id, drive_file_id)`.
- It has **no `drive_folder_id`** column (the folder is on the parent
  `sync_items` row). Prompt 11 should add `drive_folder_id` to `sync_images`
  (and include it in the duplicate lookup) so the full key above is stored on
  each image record.
- The unique key keeps one row per product + file: a changed file updates that
  row (new checksum / modified time / media ID) — history lives in
  `sync_items` / `activity_logs`.
- `filename` is for display and activity messages only, never for duplicate checks.
