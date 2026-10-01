# Image sync rules — matching, duplicate protection & Shopify upload

Rules the image sync follows. Matching: Prompt 5. Duplicate protection and the
Shopify upload service: Prompt 10B. Drive download and the sync worker come later.
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

## 2. Duplicate protection (implemented in Prompt 10B)

**Duplicate detection is NOT based on filename alone.**

❌ Wrong: "`image-01.jpg` exists anywhere → skip".

✅ Correct — one `sync_images` row per:

```
store_id + Shopify product ID + Drive file ID   (UNIQUE; checksum / modified time detect changes)
```

A Drive file ID is globally unique, so it already identifies the file inside its
product folder; `drive_folder_id` is stored on the row (Prompt 10B) for display
and audits, not needed for uniqueness. `filename` is for display only.

| Case | Example | Result |
|---|---|---|
| Same filename, different products | `Roma Sofa/image-01.jpg` and `Minor Sofa/image-01.jpg` | **Both upload** (different product + file IDs). |
| Same product, same file, unchanged | same checksum (or modified time when no checksum) as the recorded upload | **Skip** ("already uploaded"); also when a file was only renamed. |
| Same product, same file, changed | checksum (or modified time) differs | **Upload the new version** (attempts reset). The previous media stays on the product. |
| New file in folder | `image-04.jpg` added | Upload only `image-04.jpg`. |
| Folder re-mapped to another product | mapping changed | Uploads to the new product; the old product's images are never deleted. |

Change detection: prefer Drive's `md5Checksum`; fall back to `modifiedTime`
when no checksum is known. If neither is known, an uploaded file is skipped.

`sync_image_claim()` decides, under a row lock, what may happen next:

| Row state | Action |
|---|---|
| no row | `upload` (row created as `pending`) |
| `uploaded`, unchanged | `skip` |
| `processing` (media already created) | `resume` — wait for / attach **that** media, never create another |
| `pending`, claimed < 15 min ago | `busy` (another worker owns it) |
| `pending`, older than 15 min | `upload` (the worker died before Shopify created anything) |
| `failed`, retryable, media already created | `resume` |
| `failed`, retryable, no media yet, < 5 attempts | `upload` |
| `failed`, permanent (or 5 attempts used), file unchanged | `blocked` — not retried blindly |
| any failed/uploaded row whose file **changed** | `upload` |

Never delete existing Shopify images automatically (default: add only).

## 3. Shopify upload (implemented in Prompt 10B — `lib/shopify/media.ts`)

Admin GraphQL API, verified against the configured version **2026-07**:

1. `product(id)` — the product must exist in the connected shop (the token is
   shop-scoped, so another shop's product is simply not found) → else `PRODUCT_NOT_FOUND`.
2. `stagedUploadsCreate` — `resource: IMAGE` (`PRODUCT_IMAGE` is deprecated), `httpMethod: POST`.
3. multipart **POST** to the staged URL — all staged parameters first, the file last.
   No Shopify token is sent there. Staged URLs / parameters are secrets: never logged or stored.
4. `fileCreate` — `originalSource` = staged `resourceUrl`, `contentType: IMAGE`,
   `filename`, `alt`, `duplicateResolutionMode: APPEND_UUID` → `MediaImage` ID,
   **persisted immediately** with `upload_status = processing`.
5. `node(id) { ... on MediaImage { fileStatus } }` — bounded polling (default 10 × 2 s):
   `READY` → continue · `FAILED` → `IMAGE_PROCESSING_FAILED` · still processing → `MEDIA_PROCESSING_TIMEOUT` (retryable; the next attempt resumes this media).
6. `fileUpdate(files: [{ id, referencesToAdd: [productId] }])` — attaches the
   media to the product and changes nothing else.
7. `upload_status = uploaded`, `uploaded_at` set, error fields cleared.

Never used: `productCreateMedia` (deprecated), `productUpdate` / `productSet`
(product fields). Product status (draft / active / archived / unlisted) is never changed.

**Dry run** (`dry_run = true`): validates the image and reads the product only —
no `stagedUploadsCreate`, no bytes uploaded, no `fileCreate` / `fileUpdate`, no
`sync_images` writes.

### Image rules (checked before anything is sent to Shopify)

- Types: **JPG, JPEG, PNG, WEBP, GIF, HEIC** — extension, declared MIME type and the
  file's own header bytes must all agree → else `UNSUPPORTED_MIME_TYPE` / `INVALID_IMAGE`.
- Size: **≤ 20 MB** → else `IMAGE_TOO_LARGE`.
- Dimensions: **≤ 4472 × 4472 px** (read from the file header) → else `IMAGE_TOO_LARGE`;
  aspect ratio within 100:1 → else `INVALID_IMAGE`.

### Errors

| Retryable (`retryable = true`) | Permanent (`retryable = false`) |
|---|---|
| `SHOPIFY_THROTTLED` (429 / GraphQL THROTTLED, honours `Retry-After`) | `PRODUCT_NOT_FOUND` |
| `SHOPIFY_UNAVAILABLE` (5xx, 423) | `INVALID_IMAGE` |
| `NETWORK_ERROR` (timeout / connection) | `UNSUPPORTED_MIME_TYPE` |
| `STAGED_UPLOAD_FAILED` (staged 429 / 5xx / expired policy) | `IMAGE_TOO_LARGE` |
| `STAGED_UPLOAD_TIMEOUT` | `SCOPE_OR_PERMISSION` (403, ACCESS_DENIED) |
| `TOKEN_REFRESH_UNAVAILABLE` | `INVALID_REQUEST` |
| `MEDIA_PROCESSING_TIMEOUT` | `IMAGE_PROCESSING_FAILED` |
| `INTERNAL_ERROR` | `SHOPIFY_NEEDS_RECONNECT` (401, refresh rejected — store marked `needs_reconnect`) |
| | `SHOP_UNAVAILABLE` (402), `STORE_NOT_FOUND` (wrong workspace/store) |

Retryable failures are retried by a later attempt (max 5 per unchanged file);
permanent ones stay `failed` until the Drive file changes. This service does not
sleep/retry by itself — the future worker schedules retries.

Known edge: if the server stops between `fileCreate` and saving the media ID,
the next attempt (after the 15-minute lease) uploads again; the first file stays
unattached in Shopify's Files (never on the product).
