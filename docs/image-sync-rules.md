# Image sync rules — matching, duplicates, Shopify upload, Drive download & scanning

Rules the image sync follows. Matching: Prompt 5. Duplicate protection and the
Shopify upload service: Prompt 10B. Drive download: Prompt 11. Category roots + scanning: Prompt 12. The sync worker comes later.
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

## 4. Google Drive download (implemented in Prompt 11 — `lib/google/download.ts`)

`downloadDriveImage({ workspaceId, storeId, fileId }, deps)` — READ-ONLY (GET requests only;
Drive is never created/changed/moved/deleted). `workspaceId` is the server-side context
(the sync job's or session's workspace) and is only *compared* with the store's own
workspace. Root folder, Google account, allowed types and tokens always come from the
store's stored configuration — never from the caller.

Checks, in order (each failure stops before any download):

1. store exists and belongs to the context workspace → else `STORE_NOT_FOUND`
2. Google Drive connection is `connected` → else `GOOGLE_DRIVE_NOT_CONNECTED`
3. a root folder is selected → else `GOOGLE_DRIVE_ROOT_NOT_SELECTED`; the connected
   account is still the one that selected it → else `GOOGLE_DRIVE_ROOT_NOT_SELECTED`
4. token via `refreshGoogleToken()` / `getDriveClient()` (stored, encrypted connection only)
5. root folder exists, is a folder, not trashed → else `DRIVE_ROOT_INACCESSIBLE`
6. file metadata (`id, name, mimeType, size, md5Checksum, sha256Checksum, modifiedTime,
   parents, trashed`): exists, readable, not trashed → else `DRIVE_FILE_NOT_FOUND`
7. type policy = `store_settings.allowed_image_types` (default jpg/jpeg/png/webp): the
   extension must be allowed AND Drive's MIME type must match it → else `UNSUPPORTED_MIME_TYPE`
8. size ≤ 20 MB when Drive reports it → else `IMAGE_TOO_LARGE`
9. **root-folder security**: the file's parents are walked upward (bounded: 25 levels,
   100 folders) until the store's root is reached. Being readable by the Google account
   is NOT enough. Not reached → `DRIVE_FILE_OUTSIDE_ROOT`; only reachable through an
   ignored folder (e.g. `OG`) → `DRIVE_FILE_IN_IGNORED_FOLDER`; trashed folders don't count.
10. binary: `GET files/{id}?alt=media` with the store's token. The body is streamed and
    aborted once it passes 20 MB (also if `Content-Length` says so) → `IMAGE_TOO_LARGE`.
    Redirects are followed manually (max 3), only to `www.googleapis.com` /
    `*.googleusercontent.com`; the `Authorization` header is only ever sent to
    `www.googleapis.com`. One forced token refresh on 401.
11. content: the file's magic bytes must be the same type as its extension/MIME → else
    `INVALID_IMAGE`; downloaded size must equal Drive's size.
12. checksums: SHA-256 of the bytes is always computed (local integrity). Drive's
    `md5Checksum` is returned when Drive has it (source metadata for duplicate/change
    detection — not a security boundary) and is compared with the bytes, as is Drive's
    `sha256Checksum` when present; mismatch → `DOWNLOAD_INTEGRITY_FAILED` (retryable).

Result: `{ fileId, filename, mimeType, size, modifiedTime, md5Checksum, sha256, width,
height, parentFolderId, buffer }`. `buffer` is non-enumerable, so it never appears in
`JSON.stringify`, spreads or logged objects. Feed `buffer`, `md5Checksum` and
`modifiedTime` into `uploadProductImage()` (§3).

| Retryable | Permanent |
|---|---|
| `GOOGLE_DRIVE_THROTTLED` (429 / rate limit, honours `Retry-After`) | `STORE_NOT_FOUND` |
| `GOOGLE_DRIVE_UNAVAILABLE` (5xx) | `GOOGLE_DRIVE_NOT_CONNECTED` (also 401 after refresh, missing scope) |
| `NETWORK_ERROR` (timeout / connection) | `GOOGLE_DRIVE_ROOT_NOT_SELECTED`, `DRIVE_ROOT_INACCESSIBLE` |
| `TOKEN_REFRESH_UNAVAILABLE` | `DRIVE_FILE_NOT_FOUND`, `DRIVE_FILE_OUTSIDE_ROOT`, `DRIVE_FILE_IN_IGNORED_FOLDER` |
| `DOWNLOAD_INTEGRITY_FAILED` | `UNSUPPORTED_MIME_TYPE`, `IMAGE_TOO_LARGE`, `INVALID_IMAGE` |
| `INTERNAL_ERROR` | `PERMISSION_DENIED` (403 on the file, API disabled, unsafe redirect) |

## 5. Drive scanning + Shopify matching (implemented in Prompt 12 — `lib/google/scan.ts`)

Users connect **category folders** (`google_drive_category_roots`), e.g. "Sofa image",
"Sofa bed image". Everything below them is discovered:

```
Sofa image                ← category root (connected by the user)
├── SOF-001               ← code folder (direct sub-folder; discovered, NEVER matched)
│   └── Milano            ← product folder (sub-folder of a code folder) = MATCHING KEY
│       ├── 1.jpg         ← supported image directly inside the product folder
│       └── OG/…          ← ignored (store_settings.ignored_folders, case-insensitive)
└── SOF-002 / Roma / …
```

`scanCategoryRoots({ workspaceId, storeId, categoryRootIds? }, deps)` — read-only:

- **Roots**: all connected roots of the current Google account, or a subset of them
  (`CATEGORY_ROOT_NOT_CONNECTED` for anything else — a caller can't scan arbitrary
  folders). Checks first: store ∈ workspace, Google connected, same account, at
  least one root (`GOOGLE_DRIVE_ROOT_NOT_SELECTED`). An inaccessible/trashed root is
  reported (`category_root_inaccessible`) and the other roots are still scanned.
- **Levels**: direct sub-folders of a root = code folders; their sub-folders =
  product folders; files directly in a product folder = images. Ignored folders
  (OG) are skipped at every level and their images never appear. Sub-folders inside
  a product folder are reported as `nested_folders` (warning), never as products.
  Images directly in a root or a code folder are reported as warnings, not synced.
- **Images**: metadata only (no bytes): `fileId, folderId, filename, mimeType, size,
  modifiedTime, md5Checksum`. Supported = extension in `store_settings.allowed_image_types`
  AND Drive MIME type matches it (svg, pdf, zip, heic … are counted as unsupported).
  Identity is the Drive file ID (+ folder) — `Milano/1.jpg` and `Roma/1.jpg` stay separate.
- **Limits**: Drive pagination (`pageSize` 100), max 1000 code folders per root,
  50 product folders per code folder, 500 images per product folder, 2000 product
  folders per scan; hitting a limit adds a `limit_reached` warning.
- **Matching**: the **product folder name only** goes to the existing `searchProducts()`
  (Prompt 5) — never the code folder, the category folder, filenames or SKU. Results go
  through `classifyMatches()`: 0 → `no_product_found`, 1 → `single_match`, 2+ →
  `multiple_matches` with every candidate (none is chosen). Each distinct name is
  searched once per scan.
- **Errors**: Drive 429/5xx/network → the whole scan fails with the retryable Drive
  codes (`Retry-After` honoured). A Shopify throttle/outage on one search → that item is
  `search_failed` (retryable) and the scan continues; Shopify disconnected / needs
  reconnect → the scan stops with `SHOPIFY_NOT_CONNECTED`.

Known matching limitation (unchanged on purpose, Prompt 5 semantics): "contains" is a
substring rule on normalized titles, so a folder `Roma` also matches "Romano Sofa", and
Shopify's word-prefix search only returns titles where each word of the folder name
starts a word of the title. Ambiguous results surface as `multiple_matches` for review;
they are never resolved automatically.

## 6. Full sync worker (implemented in Prompt 13 — `lib/sync/worker.ts`)

`runSyncJob({ jobId, workspaceId, workerId? }, deps)` runs ONE sync job end to end. It only
orchestrates the existing services — no second scanner, downloader or uploader:

```
queued → claim (lease) → running
  for each connected CATEGORY root          ← cancellation checked first
    scanCategoryRoots()  (Prompt 12)        Category Root → Code Folder → Product Name Folder → Images
    for each PRODUCT folder                 ← cancellation checked first
      record sync_items row (category root, code folder, product folder, match, candidates)
      no_product_found / multiple_matches  → review (no download, no upload, never picks a product)
      search_failed                        → failed (job continues; 401 / shop gone → stop, needs reconnect)
      single_match → for each image         ← cancellation checked before image, download and upload
        duplicate check (sync_images state) → downloadDriveImage() (Prompt 11) → uploadProductImage() (Prompt 10B)
→ completed | completed_with_errors | cancelled | failed
```

**Only the Product Name Folder is matched to Shopify.** The code folder (`SOF-001`), the
category folder (`Sofa image`), SKUs and filenames are never used for matching. Images
placed directly in a category root or a code folder are warnings, never products — so a
test layout like `Sofa image / <code folder> / image.png` produces no product, no download
and no upload.

### Ownership and isolation
- The job row decides everything: store, `dry_run`, workspace. The worker receives only
  `jobId` + the server-side workspace (API key / session) and every DB function re-checks
  workspace → job (→ store) itself. Wrong workspace → `job_not_found`; a store outside the
  workspace → `STORE_NOT_FOUND` before anything is scanned.
- **One worker per job**: `sync_job_claim` / `n8n_start_sync_job` move `queued → running`
  and store `worker_id` + `heartbeat_at` (lease 15 min). A second claim while the lease is
  alive → `already_running`; a finished job → `finished`. Every progress write
  (`sync_job_heartbeat`, `sync_item_*`, `sync_job_finish`) requires the current
  `worker_id`; a worker that lost its lease stops immediately (`lost_lease`).
- **Crash recovery**: if the worker dies, its heartbeat stops; after the lease expires the
  next claim re-claims the job (`reclaimed`) and starts again. Restarting is idempotent:
  `sync_items` are unique per (job, product folder) and `sync_images` skips what is
  already uploaded and resumes what is `processing`.

### Duplicates (sync_images rules, unchanged)
The worker predicts the `sync_image_claim` decision from the existing `sync_images` row
(`predictImageAction`, same rules as the SQL) so it never downloads an image that won't be
uploaded; `uploadProductImage()` then makes the authoritative claim.

| sync_images state | action |
|---|---|
| uploaded, same checksum (or same modified time when there is no checksum) | skip (no download) |
| processing (media created in Shopify, not attached yet) | resume (no download) |
| failed + retryable, attempts < 5 | retry (download + upload) |
| failed + permanent, or 5 attempts | blocked (skipped, counted in `result.blocked`) |
| checksum changed / modified time changed without checksum | upload again |
| same filename, different Drive file ID | separate image, separate upload |

### Errors
- Temporary errors (Drive 429/5xx/network, Shopify throttled/unavailable) are retried
  up to 3 times per operation, honouring `Retry-After` (capped at 30 s), else 2 s / 4 s.
- Permanent file errors (unsupported type, too large, invalid image …) fail that image
  only: recorded in `sync_images` (`failed`, not retryable) and the job continues →
  `completed_with_errors`.
- **Shopify needs reconnect** (401, app uninstalled, shop gone): the uploader / search
  marks the connection `needs_reconnect`; the worker stops all further Shopify work and
  finishes the job `failed` with `SHOPIFY_NEEDS_RECONNECT`. Completed uploads are kept.
- **Google unavailable** after the retries, Google disconnected or root removed: the job
  finishes `failed` with the Google code; completed work is kept.
- Anything unexpected → `failed` / `INTERNAL_ERROR` (only the error class name is logged).

### Cancellation
`POST /sync-jobs/:jobId/cancel` on a running job sets `cancel_requested`. The worker checks
it before every category root, product folder, image, download and upload (each check is
also the heartbeat). It then stops starting new work, keeps everything already uploaded and
finishes `cancelled`. The workflow never cancels a job by itself.

### Progress and result
Progress is written on every checkpoint: `total` (product folders found), `processed`,
`uploaded` (images), `skipped` (images), `review` (product folders), `failed`, plus
`synced`, `warnings`, `errors`. The final `result` (in the job JSON) holds counts,
`blocked`, up to 100 `review_items` (folder, code folder, outcome, candidates),
`failed_items` (folder, filename, code) and scan `warnings`. No tokens, URLs or bytes.

### Dry run
`dry_run=true` performs the Drive scan, Shopify matching and reads image metadata and the
existing `sync_images` state — and nothing else: **no binary download, no Shopify upload,
no Drive or Shopify mutation, no `sync_images` write.** (`sync_items` rows are still written
so the review list exists.) `result.plan` reports what WOULD happen:
`would_upload`, `skipped`, `blocked`, `review`, `failed`.
