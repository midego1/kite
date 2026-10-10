# Spec: Drive and pluggable S3-compatible storage (ROADMAP Milestone 7)

Status: approved for a Factory Mission; third in order, after [the automatic reading agent](auto-agent.md) and [storing attachments once](attachments-once.md). Written against `main` at `22b1ac3`. Upstream reference: [hieunc229/mailflare](https://github.com/hieunc229/mailflare) commits `83ade98` (S3/B2 bucket), `9f66e13` and `3c90a03` (Drive). Both projects are AGPL-3.0; ported code names its source commit in the commit message.

Migration numbers below assume this work lands first. Earlier Missions will have used some of them, so take the next free numbers when you start and keep `tests/migration-order.test.mjs` passing.

Work on branch `mission/drive-storage`. Never push `main`, never run `npm run deploy`, `db:migrate:remote` or any `wrangler --remote` command. Do not rename `BUCKET` / `kite-raw` or any other Cloudflare resource.

---

## 1. Goals and non-goals

Goals (from `ROADMAP.md` Milestone 7):

1. **Storage providers.** R2 stays the default. A primary admin can add S3-compatible stores (AWS S3, Backblaze B2, Wasabi, Hetzner, MinIO, R2 over its S3 API). Credentials are stored encrypted with `APP_ENCRYPTION_KEY` and checked before they are saved. Large uploads and downloads use short-lived signed URLs that go straight to the store.
2. **Drive (optional).** Folders, upload, download, rename, move, trash, sharing with people, and share links that expire. An **All attachments** view lists files that arrived by mail. Drive is off by default. An admin switch, a per-user permission and a per-user quota control access. When Drive is off it is hidden and its API answers 404.
3. **Cold storage** (outline only). Move old objects to R2 Infrequent Access or to a second store, and keep reading them transparently.
4. **External storage** (outline only). WebDAV first.

Non-goals for this milestone: file versioning, office-document editing, full-text search of file contents, desktop sync clients, a public Drive API (`/api/v1/drive`), and moving message bodies out of D1 (a spike only, see section 10.4).

---

## 2. Current state in Kite (facts the design relies on)

| Fact | Where |
| --- | --- |
| Every object goes through `env.BUCKET` (R2 binding `kite-raw`). About 37 call sites use only `get` (with range), `put`, `delete`; `head` is used in places; backups also use `createMultipartUpload` | `env.d.ts:4`, `wrangler.jsonc` `r2_buckets`, `grep -rn "BUCKET" src` |
| Backups stream in 8 MiB multipart parts and fall back to one `put` when `createMultipartUpload` is missing (file bucket) | `src/lib/backups/backup-writer.ts` |
| The Node runtime swaps the binding for a directory bucket: get/put/delete/head, **no multipart, no list**; `put` buffers streams in memory | `server/runtime/file-bucket.ts`, `server/runtime/env.ts:47` |
| `getEnv()` returns `getNodeEnv() ?? cloudflare:workers env`; `worker.ts` `email`/`queue`/`scheduled` handlers use the `env` argument directly | `src/lib/cloudflare.ts`, `worker.ts:100-232` |
| SigV4 signing with Web Crypto; always hashes the body (no `UNSIGNED-PAYLOAD`, no presigning). `awsRequest` always builds `https://` URLs and buffers bodies (`string | ArrayBuffer`) | `src/lib/aws/sigv4.ts`, `src/lib/aws/client.ts` |
| S3 helpers are hard-wired to `<bucket>.s3.<region>.amazonaws.com` | `src/lib/aws/s3.ts` |
| AWS credentials pattern: sealed JSON in `app_settings.aws_config`, env-var fallback, `validateAwsConfig` probes each permission, primary-admin-only route | `src/lib/aws/config.ts`, `src/lib/aws/validate.ts`, `src/app/api/admin/aws/route.ts` |
| Secret sealing: AES-GCM, HKDF info string must never change; unsealed values pass through when no key is set | `src/lib/security/secret-box.ts` |
| CSP is per request with a nonce; `connect-src 'self' ws: wss: https://challenges.cloudflare.com`, `img-src 'self' data: blob: https:`, `frame-src 'self' …`, `upgrade-insecure-requests` | `src/lib/security/headers.ts` |
| CSRF: unsafe methods under `/api` need a same-origin check except `/api/v1`, `/api/inbound`, `/api/public`, `/api/seed` | `src/lib/security/csrf.ts` |
| Rate limits are Workers `ratelimits` bindings (`LOGIN_`, `AGENT_`, `BOOKING_RATE_LIMIT`, namespaces 1001-1003 prod, 1101-1103 previews) with Node `openRateLimiter` equivalents | `wrangler.jsonc`, `server/runtime/env.ts:69-71`, `src/lib/booking/rate-limit.ts` |
| **Preview deployments use the production D1 and bucket** | `wrangler.jsonc` `previews` comment |
| Attachments already have expiring share links (`shared_attachment_links`, `/api/shared-files/[id]`) with `Content-Disposition`, `CSP: default-src 'none'; sandbox`, `no-store`, `no-referrer` | `src/app/api/shared-files/[id]/route.ts`, `src/lib/email/shared-attachments.ts` |
| vinext treats every `POST` with `multipart/form-data` or urlencoded bodies as a possible server action and enforces a 1 MB limit, so upload bodies must be raw `PUT`s | `node_modules/vinext/dist/server/app-action-request.js` |
| Backup lists: `BACKUP_TABLES`, `REQUIRED_BACKUP_TABLES`, `INTERNAL_TABLES` (`src/lib/backups/export.ts`), `BACKUP_TABLE_GROUPS` (`table-groups.ts`), `DatabaseBackupTable` and `BackupTableGroupId` (`types.d.ts`). Restore has no per-group selection | `src/lib/backups/*` |
| Last migration `0059_add_alert_webhook.sql`, journal `idx` 62. **The next free number is `0060`** | `drizzle/migrations/` |
| The app switcher entry for Calendar lives in `src/components/mailbox-selector.tsx` (~line 305). The `(calendar)` route group is the model for a sibling app section | `src/app/(calendar)/layout.tsx` |
| The user payload from `/api/auth/me` carries permission flags (`canManage*`) | `src/app/api/auth/me/route.ts:31` |
| Public API allowlist for the e2e security spec | `e2e/support/public-routes.ts` |
| Dev-only insecure-endpoint precedent: `ALERT_WEBHOOK_ALLOW_INSECURE` | `src/lib/alerts/webhook-settings.ts`, `playwright.config.ts` |
| Object key prefixes in use: `inbound/`, `imports/`, `drafts/`, `attachments/`, `jmap-uploads/`, `backups/database/`, `avatars/`, `contact-avatars/`, `mailbox-avatars/`, `branding/app-icon`, alert state | `grep` of key templates |

---

## 3. Upstream review: summary

**Upstream storage (`83ade98`).** `withStorage(env)` returns a `Proxy` over `env` whose `BUCKET` is a `B2Bucket`. The `B2Bucket` speaks the S3 API through the shared SigV4 client and covers `get` (range), `head`, `put`, `delete` and multipart. It is chosen synchronously from `B2_*` / `S3_*` env vars. The wrapper is applied in `getEnv()`, in each `worker.ts` handler and in the Node env. Upstream also added `GET/POST /api/v1/storage` and an MCP `manage_storage` tool. The good parts are the proxy (Worker bindings are not enumerable, so spreading `env` does not work), the WeakMap cache, the B2 fix for a `200` response that carries an `<Error>`, and the health round-trip. The parts that do not fit Kite:
- Config is env-only and global (one store for everything). Kite wants Admin-managed, encrypted, per-class stores.
- Each upload part is buffered in memory, uploads always go through the Worker (no presigning), `list` is not implemented, and it is AWS/B2-specific (virtual-host only, `https` only).

**Upstream Drive (`9f66e13`, `3c90a03`).** These commits add the `drive_items` / `drive_shares` / `drive_upload_parts` tables, a global per-user cap (`app_settings.drive_storage_limit_bytes`) and a trash for attachments (`message_attachments.trashed_at`). Resumable uploads are proxied through the Worker in 64 MiB parts and resumed by fingerprint. Roles inherit from shares on ancestors. Public links use a plaintext `link_token` column with no expiry, no password and no rate limit. Upstream also has an attachments view, categories, Range downloads with sandbox CSP, 30-day trash retention, and UI under `src/app/(drive)/`. Its migrations `0055`-`0060` clash with Kite's numbering, and `0060` plus `src/lib/licenses/*` add seat licensing, which Kite must not take.

The full decision table is in section 13.

---

## 4. Architecture

### 4.1 Object classes and routing

Every key belongs to one **object class**, which is derived from its prefix. A pure helper does the mapping: `src/lib/storage/object-classes-utils.ts`.

| Class | Prefixes | Routable | Notes |
| --- | --- | --- | --- |
| `mail` | `inbound/`, `imports/`, `drafts/`, `attachments/`, `jmap-uploads/` | yes | raw MIME and attachments |
| `drive` | `drive/` | yes | Drive file contents |
| `backups` | `backups/` | yes | database backups |
| `system` | everything else (avatars, branding, alert state, `healthcheck/`) | **no, pinned to the default store** | keeps login, branding and alerts working when an external store is down; small and hot |

The **default store** is the `BUCKET` binding: R2 on Workers, the file bucket on Node. It has the reserved id `default` and has no database row. Admins add S3-compatible stores and point each routable class at one store.

### 4.2 Storage interface

New module `src/lib/storage/` (types in `types.d.ts`):

```ts
type StoreId = "default" | `sto_${string}`;
type ObjectClass = "mail" | "drive" | "backups" | "system";

interface StoreCapabilities {
	multipart: boolean;      // createMultipartUpload / resumeMultipartUpload
	presign: boolean;        // signed browser URLs (S3 stores; R2 only with S3 API keys)
	list: boolean;
	storageClasses: string[]; // e.g. ["STANDARD","STANDARD_IA"] or ["Standard","InfrequentAccess"]
}

// The R2 subset the app already uses, so `env.BUCKET` keeps its R2Bucket type for all existing callers.
type KiteBucket = Pick<R2Bucket, "get" | "head" | "put" | "delete"> &
	Partial<Pick<R2Bucket, "createMultipartUpload" | "resumeMultipartUpload" | "list">>;

interface ObjectStore {
	id: StoreId;
	bucket: KiteBucket;
	capabilities: StoreCapabilities;
	/** Present when capabilities.presign; origin is the exact URL origin added to CSP connect-src. */
	signer?: {
		origin: string;
		presignGet(key: string, o: { expiresIn: number; filename: string; disposition: "attachment" | "inline"; contentType: string }): Promise<string>;
		presignPut(key: string, o: { expiresIn: number; contentLength: number; contentType: string }): Promise<string>;
		presignUploadPart(key: string, uploadId: string, partNumber: number, o: { expiresIn: number; contentLength: number }): Promise<string>;
	};
}
```

Adapters:

| Adapter | File | Notes |
| --- | --- | --- |
| R2 binding | none (native) | used as is; `put` accepts `storageClass` (phase 3) |
| File bucket (Node) | `server/runtime/file-bucket.ts` | **add** multipart (port upstream `9f66e13` version), streaming `put` (pipe a `ReadableStream` to disk instead of `new Response(value).arrayBuffer()`), and a simple `list({ prefix, cursor, limit })` |
| S3-compatible | `src/lib/storage/s3-bucket.ts` (new; adapted from upstream `b2-bucket.ts`) | see 4.3 |

Drive code and the migration job use `getStorage(env)` from `src/lib/storage/index.ts`, which returns `{ storeFor(cls), store(id), router }`. Existing code keeps using `env.BUCKET`.

### 4.3 S3 adapter (`s3-bucket.ts`) requirements

- Config `{ endpoint, region, bucket, addressing: "virtual" | "path", accessKeyId, secretAccessKey, scheme: "https" | "http" }`. `http` is allowed only under the dev flag (4.6). Provider presets in `s3-presets-utils.ts`:
  - AWS: `s3.<region>.amazonaws.com`, virtual addressing.
  - B2: `s3.<region>.backblazeb2.com`, with the region parsed as in upstream `b2RegionFromEndpoint`.
  - Wasabi: `s3.<region>.wasabisys.com`.
  - Hetzner: `<region>.your-objectstorage.com`.
  - R2: `<accountId>.r2.cloudflarestorage.com`, region `auto`.
  - MinIO / other: custom host, path addressing.
- `get` with `range` (offset/length/suffix), `head`, `put`, `delete` (ignore 404; batches of 10 in parallel as upstream), multipart (`create`, `uploadPart`, `complete`, `abort`, plus `listParts` for diagnostics), `list` (ListObjectsV2), and `copy` (CopyObject within one store; used for "Save to Drive" when source and target store are the same).
- **Streaming instead of buffering.** Extend `signAwsRequest` with `payloadHash?: "UNSIGNED-PAYLOAD"` and let `awsRequest` take a `ReadableStream` body with a known `contentLength`. On Workers, pipe through `FixedLengthStream(length)`. On Node, pass `duplex: "half"` and `Content-Length`. Without a known length, buffer up to 32 MiB and refuse anything larger. This also requires a URL scheme option (`http` for MinIO in dev) and support for path-style hosts.
- Map `httpMetadata` to `Content-Type`/`Content-Disposition`/`Cache-Control`, and `customMetadata` to `x-amz-meta-*`. **Percent-encode metadata values.** S3 headers are ASCII-only, and `inbound.ts:280` stores `from`/`to`, which can contain UTF-8. Decode the values on read.
- Keep upstream's check for a `<Error>` document inside a `200` response on CompleteMultipartUpload (B2 and AWS can both do this).
- Return objects shaped like `R2ObjectBody` (`body`, `size`, `etag`, `httpEtag`, `uploaded`, `httpMetadata`, `customMetadata`, `writeHttpMetadata`, `arrayBuffer`, `text`, `json`, `blob`), as upstream `B2Object` does.
- Presigning: add `presignAwsUrl()` to `src/lib/aws/sigv4.ts` (query-string auth, `X-Amz-Expires` ≤ 3600, `UNSIGNED-PAYLOAD`). Signed headers are `host` and, for PUT and UploadPart, `content-length`, so the store rejects any body whose size differs from the reserved size. GET URLs carry `response-content-disposition` and `response-content-type`.
- Map errors with the existing `AwsError`. `NoSuchKey`/404 means `null`.

### 4.4 Router and where it plugs in

`src/lib/storage/router.ts` implements `KiteBucket` and is installed as `env.BUCKET` through `withStorage(env)`. This keeps upstream's `Proxy` + `WeakMap` pattern, because Worker bindings cannot be spread.

- **Config load.** One D1 query reads `storage_routes` joined with `storage_stores`. The result is cached in module memory for 30 s and invalidated in the isolate that saves a change. Credentials are opened (`openSetting`) lazily and are only ever cached in memory. With no rows (the default install), the router delegates straight to the raw binding after that one cached query.
- **Writes** (`put`, `createMultipartUpload`) go to the class's active store.
- **Reads** (`get`, `head`) try the chain `[active, previous (while migrating), default]` without duplicates, and from phase 3 also `object_locations` on a miss. Ending the chain at the default store means that objects written during a config-read outage, or by an isolate with a stale config, are still readable. The migration verify pass later moves those strays.
- **Deletes** go to the active and previous store (404 is ignored).
- **Config read fails.** Use the last known config. If no config has ever been loaded, use the default store and log `storage.config_unavailable`. Inbound mail must not be bounced because of a transient D1 read.
- `resumeMultipartUpload` goes to the active store. Long-lived uploads (Drive) always address their recorded `store_id` explicitly through `getStorage(env).store(id)` and never rely on the router.

Plug-in points (both runtimes):

| Runtime | Where | Change |
| --- | --- | --- |
| Workers, Next routes | `src/lib/cloudflare.ts` `getEnv()` | `return withStorage(getNodeEnv() ?? env)` |
| Workers, raw handlers | `worker.ts` `fetch` (the realtime path does not need it), `email`, `queue`, `scheduled` | `const env = withStorage(rawEnv)` at the top of each |
| Node | `server/runtime/env.ts` `createNodeRuntime` | wrap before `realtime.bindEnv` and before publishing `globalThis.__kiteNodeEnv`; the scheduler (`server/runtime/scheduler.ts`) receives the wrapped env |
| Tests | `tests/*.test.mjs` | construct a router over two `FileBucket`s and a `SqliteDatabase` |

`withStorage` must be idempotent: a proxied env is returned unchanged.

### 4.5 Configuration storage and validation

- Credentials are sealed JSON (`sealSetting`) in `storage_stores.credentials`. **Saving an S3 store is refused when `APP_ENCRYPTION_KEY` is unset.** This is stricter than the AWS settings, on purpose. Show the reason in the UI.
- Optional bootstrap for Docker (phase 1, low priority): `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`, `STORAGE_S3_ADDRESSING`, `STORAGE_S3_CLASSES=mail,drive,backups`. These env vars appear as a read-only store (`source: "environment"`), like `getAwsConfigStatus`. They are never written to D1.
- `validateStore(config)` in `src/lib/storage/validate.ts` runs before saving and from the **Test** button:
  1. Endpoint guard (4.6).
  2. HeadBucket.
  3. Put/get/delete of a probe object under `healthcheck/` (port upstream `health.ts` `testStorage`).
  4. Create and abort a multipart upload.
  5. Fetch a presigned GET of the probe, which catches clock skew and signature-style problems.
  6. CORS preflight: `OPTIONS` with `Origin: <app origin>`, `Access-Control-Request-Method: PUT`, `Access-Control-Request-Headers: content-type`. Expect `Access-Control-Allow-Origin` and `Expose-Headers: ETag`.
  7. Report each failing step with the permission or policy that fixes it (the same pattern as `AWS_IAM_POLICY`): `s3:GetObject`, `PutObject`, `DeleteObject`, `ListBucket`, `AbortMultipartUpload`, `ListMultipartUploadParts`. Offer **Apply CORS** (PutBucketCors) on AWS, R2, MinIO and Wasabi, and show a CORS JSON snippet for B2 and others.
  8. Recommend (and on AWS/MinIO, offer to add) a lifecycle rule `AbortIncompleteMultipartUpload` after 7 days. R2 aborts by default after 7 days. This extends `putExpiryLifecycle` in `src/lib/aws/s3.ts` into a general lifecycle writer.
- **R2 direct mode.** The default R2 bucket can presign only if the admin adds R2 S3-API credentials (account id + R2 token key pair). This is saved as a store row with `same_as_binding = 1`: server-side operations still use the binding, and the credentials are used only to sign browser URLs. Without them, R2 uploads are proxied (4.7).

### 4.6 Endpoint and network rules

- Workers: the endpoint must be public `https`. Use `assertPublicHttpUrl` (`src/lib/security/outbound-url.ts`). `global_fetch_strictly_public` blocks private addresses anyway.
- Node: private and LAN hosts (MinIO in `docker-compose.yml`) are allowed only with `STORAGE_ALLOW_PRIVATE_ENDPOINTS=1`.
- `http` is allowed only with `STORAGE_ALLOW_INSECURE_ENDPOINT=1` in dev/test, following the same rule as `ALERT_WEBHOOK_ALLOW_INSECURE` (ignored in production). Playwright sets it in `webServer.env`.

### 4.7 Upload and download flows (Drive)

Part size depends on the mode:
- **Direct:** 64 MiB parts. The browser sends them straight to the store, so Worker body limits do not apply.
- **Proxied:** 32 MiB parts. This stays under the 100 MB request limit on Free/Pro plans and keeps memory flat.

The object limit is 10 000 parts. A file with one part may be any size from 1 byte. A 0-byte file is stored with a plain `put`.

**Direct (store has `presign`):**
1. `POST /api/drive/uploads` `{ name, size, contentType, parentId, fingerprint }`. Inside one D1 statement, the server reserves quota and inserts a `drive_items` row with `status = 'uploading'`, `store_id`, `object_key = drive/<itemId>` (4.8). It then calls CreateMultipartUpload and returns `{ id, mode: "direct", partSize, parts, uploaded: [] }`. On resume (same owner, parent, name, size and fingerprint, not expired), it returns the existing row and the parts already recorded, as upstream does.
2. `POST /api/drive/uploads/[id]/part-urls` `{ partNumbers }` (at most 20 per call) returns presigned UploadPart URLs (15 min, `content-length` signed).
3. The browser PUTs each part with `XMLHttpRequest` (for progress) and `credentials: "omit"`, **sending no Kite headers**. It reads `ETag` from the response and reports it with `PUT /api/drive/uploads/[id]/parts/[n]` `{ etag }`. The server records the part in `drive_upload_parts`.
4. `POST /api/drive/uploads/[id]/complete` runs CompleteMultipartUpload (the store rejects wrong ETags with `InvalidPart`), then HEAD, and checks the size. If the size differs, the server deletes the object and the row and returns 409. On success, `status = 'ready'`.

**Proxied (default R2 without S3 keys, or the Node file bucket):** the same steps 1 and 4, but step 2/3 becomes `PUT /api/drive/uploads/[id]/parts/[n]` with a raw `application/octet-stream` body. The handler checks the exact `Content-Length` (every part except the last must be full size, as upstream does) and streams `request.body` into `uploadPart`. **Verify that vinext passes `request.body` through as a stream.** If it buffers, mount this one endpoint in `worker.ts` ahead of vinext, the same way `/api/realtime` is mounted. Do the equivalent in `server/index.ts`.

**Downloads:** `GET /api/drive/files/[id]/content?disposition=inline|attachment`.
- Previews and inline content are always streamed same-origin with Range and If-Range support. This ports upstream `parseByteRange` / `streamDriveFile` with these headers:
  - `X-Content-Type-Options: nosniff`
  - `CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox`, or `frame-ancestors 'self'` only for PDF, matching upstream's documented exception for Chrome's viewer
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: private, no-store`
  - Inline only for the safe allowlist `isDriveInlineSafe`: no HTML and no SVG.
- When the store can presign, `disposition=attachment` and the size is at least 8 MiB, respond `302` to a presigned GET (5 min, `response-content-disposition=attachment; filename*=…`, `response-content-type=application/octet-stream`) with `Cache-Control: no-store`. Otherwise stream.
- Public links always stream through Kite (section 8). That hides the store, keeps expiry checked server-side and keeps rate limiting accurate.

**CSP.** Same-origin previews need no CSP change: `frame-src 'self'` exists, and `media-src` falls back to `default-src 'self'`. Direct uploads need the store origin in `connect-src`. Change `buildContentSecurityPolicy({ nonce, dev, connectSources })` and add the exact presign-capable store origins (no wildcards) for **every** document response, because client-side navigation keeps the first document's CSP. Read the origins from the router's cached config in `worker.ts` and `server/index.ts`. Do not widen `img-src`; it already allows `https:`, and that should be revisited separately. `upgrade-insecure-requests` affects http stores in e2e, so serve the fake store on `localhost` (loopback is not upgraded) and verify early.

### 4.8 Object keys

- Drive: `drive/<itemId>`. Do not put the owner id or the file name in the key: renames and ownership changes then never touch storage, and no PII ends up in key names. Store `object_key` and `store_id` on the row.
- Saved-from-mail copies get a new Drive key. The copy is independent of the attachment.

---

## 5. Data model and migrations

Hand-written SQL in the generated style, with journal entries continuing from `idx` 63. Mirror the schema in `src/db/schema/index.ts` and run `npm run db:bundle`.

### `0060_add_storage_stores.sql` (phase 1)

```sql
CREATE TABLE `storage_stores` (
	`id` text PRIMARY KEY NOT NULL,            -- sto_…
	`name` text NOT NULL,
	`provider` text NOT NULL,                  -- aws | r2 | b2 | wasabi | hetzner | minio | other
	`endpoint` text NOT NULL,
	`region` text NOT NULL,
	`bucket` text NOT NULL,
	`addressing` text DEFAULT 'virtual' NOT NULL,
	`credentials` text NOT NULL,               -- sealed JSON {accessKeyId, secretAccessKey}
	`same_as_binding` integer DEFAULT 0 NOT NULL, -- R2 S3 keys for the BUCKET binding, used only to presign
	`status` text DEFAULT 'unchecked' NOT NULL,   -- ok | error | unchecked
	`last_checked_at` integer, `last_error` text,
	`created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_routes` (
	`object_class` text PRIMARY KEY NOT NULL,  -- mail | drive | backups
	`store_id` text NOT NULL,                  -- 'default' or storage_stores.id (no FK: 'default' has no row)
	`previous_store_id` text,                  -- read fallback while a migration runs
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`object_class` text NOT NULL, `from_store_id` text NOT NULL, `to_store_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,   -- queued | copying | verifying | completed | failed | cancelled
	`cursor` text,                             -- JSON per source table
	`objects_total` integer DEFAULT 0 NOT NULL, `objects_done` integer DEFAULT 0 NOT NULL,
	`bytes_done` integer DEFAULT 0 NOT NULL, `errors` integer DEFAULT 0 NOT NULL, `last_error` text,
	`created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`created_at` integer NOT NULL, `started_at` integer, `finished_at` integer
);
```

### `0061_add_drive.sql` (phase 2)

```sql
CREATE TABLE `drive_items` (
	`id` text PRIMARY KEY NOT NULL,            -- drv_…
	`owner_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`parent_id` text,                          -- no FK on purpose: restore inserts rows in table order, not tree order
	`kind` text NOT NULL,                      -- file | folder
	`name` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`store_id` text, `object_key` text,        -- files only
	`status` text DEFAULT 'ready' NOT NULL,    -- uploading | ready
	`upload_id` text, `upload_part_size` integer, `upload_fingerprint` text, `upload_expires_at` integer,
	`source_attachment_id` text,               -- informational, no FK
	`trashed_at` integer,
	`created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
CREATE INDEX `drive_items_owner_parent_idx` ON `drive_items` (`owner_id`,`parent_id`,`status`);
CREATE INDEX `drive_items_parent_idx` ON `drive_items` (`parent_id`);
CREATE INDEX `drive_items_trashed_idx` ON `drive_items` (`trashed_at`);
CREATE INDEX `drive_items_upload_expiry_idx` ON `drive_items` (`upload_expires_at`);
CREATE TABLE `drive_shares` (                -- port of upstream
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL REFERENCES `drive_items`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`role` text DEFAULT 'view' NOT NULL,       -- view | edit
	`created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`created_at` integer NOT NULL
);
CREATE UNIQUE INDEX `drive_shares_item_user_idx` ON `drive_shares` (`item_id`,`user_id`);
CREATE INDEX `drive_shares_user_idx` ON `drive_shares` (`user_id`);
CREATE TABLE `drive_links` (                 -- replaces upstream drive_items.link_token
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL REFERENCES `drive_items`(`id`) ON DELETE cascade,
	`token_hash` text NOT NULL,                -- SHA-256 of the 32-byte random token (base64url)
	`token_sealed` text,                       -- sealed token so the owner can copy it again; null without APP_ENCRYPTION_KEY (shown once)
	`password_hash` text,                      -- optional, same hasher as account passwords
	`expires_at` integer,                      -- null only when the admin allows links without expiry
	`download_count` integer DEFAULT 0 NOT NULL, `last_accessed_at` integer,
	`revoked_at` integer,
	`created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`created_at` integer NOT NULL
);
CREATE UNIQUE INDEX `drive_links_token_idx` ON `drive_links` (`token_hash`);
CREATE INDEX `drive_links_item_idx` ON `drive_links` (`item_id`);
CREATE TABLE `drive_upload_parts` (
	`item_id` text NOT NULL REFERENCES `drive_items`(`id`) ON DELETE cascade,
	`part_number` integer NOT NULL, `etag` text NOT NULL, `size` integer NOT NULL
);
CREATE UNIQUE INDEX `drive_upload_parts_idx` ON `drive_upload_parts` (`item_id`,`part_number`);
ALTER TABLE `users` ADD `can_use_drive` integer DEFAULT false NOT NULL;
ALTER TABLE `users` ADD `drive_quota_bytes` integer;                 -- null = app default
ALTER TABLE `app_settings` ADD `drive_enabled` integer DEFAULT false NOT NULL;
ALTER TABLE `app_settings` ADD `drive_default_quota_bytes` integer;  -- null = unlimited
ALTER TABLE `app_settings` ADD `drive_link_max_days` integer DEFAULT 30 NOT NULL; -- 0 = public links off; -1 = no expiry allowed
ALTER TABLE `app_settings` ADD `drive_trash_retention_days` integer DEFAULT 30 NOT NULL;
```
(Separate the statements with `--> statement-breakpoint`.)

Later phases: `0062_add_object_locations.sql` (phase 3: `object_locations(key PK, store_id, storage_class, size, moved_at)`, `drive_items.storage_class`, `storage_cold_rules`) and `0063_add_drive_mounts.sql` (phase 4: WebDAV). Renumber if other work lands first. `tests/migration-order.test.mjs` guards the order.

### Quota rule (atomic)

Usage is `SUM(size)` over the owner's `drive_items`, **including** trashed items and uploads in progress. Uploads into a folder shared with edit rights count against the folder owner, as upstream does. The reservation must be a single conditional insert so that concurrent uploads cannot overshoot:

```sql
INSERT INTO drive_items (...) SELECT ... WHERE
  (SELECT coalesce(sum(size),0) FROM drive_items WHERE owner_id = ?1) + ?size <= ?limit
```
Zero rows changed means `413 { error: "Not enough Drive storage left for this file" }`. The effective limit is `users.drive_quota_bytes ?? app_settings.drive_default_quota_bytes`, and null means unlimited.

### Backup lists (same change as each migration, per `AGENTS.md`)

| Table | List | Group |
| --- | --- | --- |
| `storage_stores`, `storage_routes` | `BACKUP_TABLES` (before `app_settings`) | `system` |
| `storage_migrations` | `INTERNAL_TABLES`, with a comment: a transient job that points at live stores; replaying it would restart a copy | — |
| `drive_items`, `drive_shares`, `drive_links` | `BACKUP_TABLES` after `users` (FK order: items, then shares and links) | **new group `drive`** ("Drive files and sharing"); add `"drive"` to `BackupTableGroupId` |
| `drive_upload_parts` | `INTERNAL_TABLES`: in-flight multipart state is meaningless after a restore | — |

Also:
- Add every new table to `DatabaseBackupTable`, but not to `REQUIRED_BACKUP_TABLES`, so older documents still restore.
- **Restore keeps the live storage config.** When the target database already has `storage_stores` or `storage_routes` rows, restore keeps them instead of replacing them, so a restore cannot point the install at stores whose credentials or contents differ. On an empty install they are restored. This needs a small `PRESERVED_ON_RESTORE` rule in `src/lib/backups/restore-utils.ts`. Flag it for human review.
- Document that backups contain Drive metadata but not file contents, as for mail objects today (`docs/privacy.md` "What is stored where", `docs/operations.md`).

D1 size: one `drive_items` row is about 300 B, so 1 M files is about 0.3 GB of the 10 GB cap. Only metadata goes to D1.

---

## 6. API routes

All session routes:
- Use `requireSessionUser` (never `requireUser`; `tests/route-auth.test.mjs` enforces this).
- Check `hasValidSessionMutationOrigin` for mutations.
- Return `NextResponse.json({ error }, { status })` on failure.

The Drive gate is `requireDriveUser(request, { mutation })` in `src/lib/drive/auth.ts`, an adaptation of upstream `authorizeDrive`:
- No session: 401 (the e2e security spec expects 401/403 for every non-public route).
- `drive_enabled` is false, the user lacks `can_use_drive`, or the user is disabled: **404 `{ error: "Not found" }`**.

### Storage (phase 1, primary admin only, as `src/app/api/admin/aws/route.ts`)

| Method and path | Purpose |
| --- | --- |
| `GET /api/admin/storage` | stores (no secrets: key hint = last 4 characters), routes, capabilities, running migration, usage per class from D1 sums |
| `POST /api/admin/storage/stores` | validate (4.5) and then save; 422 with the step report on failure |
| `PATCH/DELETE /api/admin/storage/stores/[id]` | update (re-validates), delete (refused while routed, or while any `drive_items.store_id` or migration references it) |
| `POST /api/admin/storage/stores/[id]/test` | run `validateStore` and update `status` |
| `POST /api/admin/storage/stores/[id]/cors` | apply the CORS rule where the provider supports it |
| `PUT /api/admin/storage/routes/[class]` | `{ storeId, migrate: boolean, copyBackups?: boolean }` switches the route and optionally queues a migration |
| `GET/POST /api/admin/storage/migrations/[id]` | progress; `POST { action: "cancel" | "finish" | "purge-source" }` (purge requires a typed confirmation) |
| `GET/POST /api/v1/storage` | (optional) admin API key scope `storage`: status and test, adapted from upstream. Add `storage` to `ADMIN_API_KEY_SCOPES` (`src/lib/api/scopes.ts`), the OpenAPI document and the MCP `manage_storage` tool (`src/lib/mcp/admin-tools.ts`) |

### Drive settings (phase 2)

| Method and path | Purpose |
| --- | --- |
| `GET/PATCH /api/admin/drive` | `drive_enabled`, default quota, link max days, trash retention, `grantAll: true` (gives every enabled account access). Admin (`isAdmin`) |
| `PATCH /api/accounts/[id]` | extend with `canUseDrive`, `driveQuotaBytes` (existing `canManageUsers` rules) |
| `GET /api/auth/me` | add `features: { drive: boolean }` (global switch AND user permission) |

### Drive (phase 2, session plus Drive gate)

| Method and path | Purpose |
| --- | --- |
| `GET /api/drive/items?view=my|shared|recent|trash&parent=&q=&types=&cursor=` | listing (port upstream `items/route.ts`, add cursor pagination on `(updated_at, id)`); response includes `usage { used, limit }` |
| `POST /api/drive/folders` | create folder |
| `GET/PATCH/DELETE /api/drive/items/[id]` | details with breadcrumb; rename or move (`{ name?, parentId? }`, refuse moving into its own subtree, depth ≤ 64); `DELETE` = delete forever (owner, only from trash) |
| `POST /api/drive/items/bulk` | `{ ids, action: trash | restore | delete | move, parentId? }` (≤ 100 ids) |
| `GET /api/drive/files/[id]/content` | stream, Range, or presigned redirect (4.7) |
| `GET/POST/DELETE /api/drive/items/[id]/shares` | people sharing (owner or edit role may share with view; only the owner grants edit); the user picker lists active accounts on the install |
| `GET/POST /api/drive/items/[id]/links`, `PATCH/DELETE /api/drive/links/[id]` | create `{ expiresInDays, password? }` (bounded by `drive_link_max_days`), list, revoke; the response includes the URL only when it can be shown (see `token_sealed`) |
| `POST /api/drive/uploads`, `POST /api/drive/uploads/[id]/part-urls`, `PUT /api/drive/uploads/[id]/parts/[n]`, `POST /api/drive/uploads/[id]/complete`, `DELETE /api/drive/uploads/[id]` | upload lifecycle (4.7); `DELETE` aborts |
| `GET /api/drive/attachments?types=&cursor=` | All attachments (port upstream `listDriveAttachments` minus the trash, scoped by `listAccessibleMailboxes`, cursor pagination) |
| `GET /api/drive/attachments/[id]/content` | stream via the existing attachment access check (`getAttachmentForUser` in `src/lib/email/attachments.ts`) |
| `POST /api/drive/attachments/[id]/save` | `{ parentId }` copies into Drive (quota-checked; same store: `copy`, else stream get→put) |

### Public links (phase 2, no session, under the CSRF-exempt `/api/public`)

| Method and path | Purpose |
| --- | --- |
| `GET /api/public/drive/[token]?item=` | metadata, or the folder listing for a descendant (port upstream `getPublicDriveItem` subtree check) |
| `GET /api/public/drive/[token]/content?item=&download=1` | stream (always proxied) |
| `POST /api/public/drive/[token]/unlock` | `{ password }` sets an HttpOnly, Secure, SameSite=Strict cookie `kite_link_<linkId>` (HMAC of link id + expiry, 1 h, `Path=/api/public/drive/<token>`) |

Unknown, expired and revoked links, a trashed item or ancestor, Drive switched off, and an owner without Drive permission or with a disabled account all return the same 404 `{ error: "Link not found" }`. A missing unlock returns 401 `{ passwordRequired: true }` only for a valid link. Add these routes to `e2e/support/public-routes.ts` with exact statuses.

After adding routes, regenerate `docs/api-inventory.md`, `docs/openapi.json` and `src/lib/metrics-routes.generated.json` with `node scripts/docs-generate.mjs`.

---

## 7. UI screens

All screens must work in Kite, Classic and dark mode, use the `blue-*` palette, and set `max-h-[calc(100vh-4rem)] overflow-y-auto` on taller dialogs. Put types and helpers in sibling `*-types.d.ts` / `*-utils.ts` files. Upstream's `en.json` strings are inlined, because Kite has no i18n library.

1. **Admin → Storage** (`src/app/(admin)/storage/page.tsx`, primary admin; add an admin nav entry).
   - Stores list: name, provider, bucket, status badge, last check, Test, Edit, Delete.
   - The Default (R2 or Local files) row is always present. It has an "Enable direct uploads" action that adds R2 S3 keys.
   - **Add store** dialog: provider preset, endpoint, region, bucket, addressing, key ID and secret, then a step-by-step test checklist with the fix shown for each failed step, a CORS snippet and Apply CORS.
   - A "Where data lives" table (Mail, Drive, Backups, each with a store select) and a **Switch** confirm dialog. The dialog explains the cost (source egress, destination writes), the "copy existing data" checkbox and the note that **Preview deployments share this setting**.
   - A migration progress card (objects and bytes, errors, Cancel, Finish, Delete from old store).
   - Usage per class.
2. **Admin → General: Drive card**, or a section on the Storage page: switch, "Give all accounts access", default quota (GB, empty = unlimited), maximum link lifetime (days / links off / allow no expiry), trash retention days.
3. **Admin → Accounts → [id]** (`src/app/(admin)/accounts/[id]`): a "Can use Drive" toggle, a quota override and a usage bar.
4. **Drive app** (`src/app/(drive)/layout.tsx`, modelled on `(calendar)`; routes `/drive`, `/drive/f/[folderId]`, `/drive/shared`, `/drive/attachments`, `/drive/trash`).
   - Left nav with a usage bar. Toolbar: New folder, Upload files, Upload folder. Breadcrumbs. List view with name, owner, modified and size, plus type filter chips (port `categories.ts`).
   - Drag-drop upload and drag-to-move (port `drive-drag.ts`). Multi-select bulk actions: move, download, trash, restore, delete forever.
   - Rename dialog, move dialog with a folder picker, preview dialog (image, PDF iframe, text, audio and video, all same-origin).
   - **Share dialog:** people with roles; links with expiry, optional password, copy, revoke, last access and download count.
   - Upload panel with per-file progress, resume, cancel and a quota error (port `drive-upload.ts` / `drive-upload-panel.tsx`; route the direct mode to the store URL).
   - The app switcher in `src/components/mailbox-selector.tsx` shows Drive only when `features.drive`. When the gate fails, the layout renders the Kite not-found page.
5. **Public link page** (`src/app/d/[token]/page.tsx`): a minimal page with branding name and icon only. It shows a file preview and download, or a folder listing with breadcrumbs inside the shared subtree, plus a password form and an expired state. There is no app chrome, no account data and no session call.
6. **Mail integration:**
   - "Save to Drive" in the attachment menu of the reader (when `features.drive`).
   - Stretch: "Attach from Drive" in the composer. It copies into the draft's attachments within the outbound attachment limit, or inserts a Drive link for larger files.

---

## 8. Security review points

1. **Credentials:**
   - Store credentials only sealed; refuse to save without `APP_ENCRYPTION_KEY`.
   - Never return secrets. The GET response carries only the last 4 characters of the key ID.
   - Restrict storage management to the primary admin.
   - Write an audit log entry (`createAuditLog`, `src/lib/mailboxes/audit.ts`) for store create, update and delete, route switches, migration purge, Drive switch changes and link creation.
   - Never log presigned URLs.
2. **SSRF:** apply the endpoint guard (4.6) on save and on every config load. The dev flags must be ignored in production.
3. **Presigned URLs:**
   - Short expiry (15 min for uploads, 5 min for downloads).
   - `content-length` is signed, so the size cannot be inflated past the reservation.
   - The size is verified by HEAD at completion.
   - Keys are server-chosen (`drive/<id>`), so the client can never choose a key.
   - URLs are only issued after the role check.
   - The browser PUT sends no cookies and no Kite headers (the CSRF token must not leak to the store).
4. **Content serving:**
   - Inline only for the safe allowlist. HTML, SVG and XML are always served as an `attachment` with `application/octet-stream`.
   - Send `nosniff`, sandbox CSP, `no-store`, and RFC 5987 `filename*` in `Content-Disposition`. Reuse `getAttachmentContentDisposition` (`src/app/api/messages/[messageId]/attachments/[attachmentId]/utils.ts`; move it to `src/lib/http/` if both sides import it).
   - Presigned GETs carry forced `response-content-type` and `response-content-disposition=attachment`.
5. **Public links:**
   - The token is 32 random bytes, compared by SHA-256 hash.
   - Expiry is required unless the admin allows otherwise. Links can be revoked and are re-checked on every request.
   - Password attempts are rate limited.
   - Every failure answers with the same 404.
   - The page and API never read or set `ep_session`, and never expose the owner email, owner id, store, bucket or object keys.
   - Send `Referrer-Policy: no-referrer` and keep the `X-Robots-Tag` noindex.
   - The page loads no third-party resources, so the token cannot leak through Referer.
   - Folder links are limited to their subtree, checked through the ancestor chain.
6. **Rate limiting:**
   - New binding `DRIVE_LINK_RATE_LIMIT`: namespace `1004` in prod and `1104` in previews, 60 requests per 60 s, keyed by IP from `src/lib/security/client-ip.ts`.
   - Unlock is keyed by `ip:linkId` and allowed 5 per minute, using the same binding with a separate key prefix or `LOGIN_RATE_LIMIT`.
   - Add Node `openRateLimiter(60, 60)` in `server/runtime/env.ts`, the `env.d.ts` type and `wrangler.jsonc.example`.
   - Upload initiation is limited per user (for example 120/min, reusing the binding with a `upload:<userId>` key).
7. **Access control:**
   - Roles are owner, edit and view. A share on any ancestor applies to the whole subtree (port `getDriveRole`).
   - A trashed ancestor hides its descendants.
   - Replace upstream's N+1 parent walk with one `WITH RECURSIVE` CTE (depth ≤ 64).
   - Only the owner can delete forever or create links with edit-like reach. Shared editors can upload, rename and move within the shared folder, but cannot move items out of it.
   - The All attachments view is scoped by `listAccessibleMailboxes`.
8. **Hidden when off:** API 404, page not-found, nav hidden, and public links 404. Tests must cover each of these.
9. **Quota and abuse:**
   - Use the atomic reservation.
   - Abort and delete expired uploads (`upload_expires_at`, 3 days) in the daily job, and cap each user at 20 uploads in progress.
   - Validate names (port `normalizeDriveName`: no control characters, no `/` or `\`, no `.` or `..`, ≤ 255 characters).
10. **Store migration safety:**
    - Never delete from the source automatically.
    - The verify pass runs before completion.
    - Reads fall back through the chain.
    - Preview deployments write the production config, so this is documented and the UI warns about it.
11. **Backups:** sealed secrets stay sealed inside backup documents, and a restore keeps the live storage config (section 5).

---

## 9. Switching a store and migrating existing data

Flow (`src/lib/storage/migration.ts`, with a pure planner in `migration-utils.ts`):

1. The admin picks class X → store B (from A). B must have passed validation within the last hour.
2. Save the route `store_id = B`, `previous_store_id = A` and insert a `storage_migrations` row (`queued`). From then on, new writes go to B (other isolates follow within 30 s) and reads use the chain B → A → default.
3. The job runs on the existing queues: `OUTBOUND_QUEUE` message `{ kind: "storage.migrate", jobId }`, re-enqueued after each batch, the same way `isMailboxPurgeMessage` works in `worker.ts`. The `*/5` cron restarts a stalled job. On Node, use the in-process queue. Batches are at most 50 objects or 256 MiB, and objects over 64 MiB are copied as multipart. The adapter streams with known lengths taken from `R2Object.size`.
4. Keys come from D1, not from bucket listing:
   - mail: `messages.raw_r2_key`, `message_attachments.r2_key`, `drafts/`, `imports/`
   - drive: `drive_items.object_key WHERE store_id = A`
   - backups: `backups.r2_key`

   The cursor is stored per source table. For Drive, each row's `store_id` is updated after its object is copied and verified.
5. **Verify:** HEAD each key on B and compare sizes. Missing objects (for example, written to A by a stale isolate) are copied again. Then the job is `completed`.
6. **Finish** (manual, or automatic after 7 days): clear `previous_store_id`. **Delete from old store** is a separate, explicit action with typed confirmation. Orphans (objects in A that no D1 row references) are listed through `list` when A supports it, and are never deleted automatically.
7. **Rollback** is a migration in the opposite direction, which is safe because of the read chain.
8. Copying backups is optional (checkbox, on by default).

Unit tests: `tests/storage-migration.test.mjs` over `SqliteDatabase` + `applyMigrations` with two `FileBucket`s. It covers the copy, resuming from the cursor, idempotent re-runs, catching strays in verify, cancellation, and Drive `store_id` updates.

---

## 10. Cold storage (phase 3, outline)

### 10.1 Cost model (verify current prices before shipping)

R2 Standard costs about $0.015/GB-month and Infrequent Access about $0.010/GB-month. IA adds $0.01/GB retrieval, higher operation prices (Class A about $9/M versus $4.50/M) and a 30-day minimum storage duration. The saving is about $0.005/GB-month. One transition (a Class A write) costs about $9e-6, so a never-read object breaks even within 12 months only above roughly 150 KB. Each full read costs about two months of savings.

Typical mail objects (raw MIME and attachments of tens of KB) are read now and then, which confirms the earlier finding: **IA costs more than it saves for mail**. Large, rarely read objects (Drive files of 1 MiB and up, and backups) do pay off. Show this formula and the numbers in the settings, next to the warnings that IA bills every read and keeps objects at least 30 days.

### 10.2 Options

- **R2 IA, same bucket and key** (reads are transparent; no location record needed):
  - `backups/`: an R2 lifecycle rule (age ≥ 30 d → IA), set through the Cloudflare API (`PUT /accounts/{account_id}/r2/buckets/kite-raw/lifecycle`). This needs `CF_TOKEN` with R2 edit and `CF_ACCOUNT_ID`. R2 lifecycle rules filter by prefix and age only.
  - `drive/`: app-driven, because a size filter is needed. A daily job rewrites qualifying objects with `put(key, body, { storageClass: "InfrequentAccess" })` (supported by the R2 binding) and records `drive_items.storage_class`.
  - `mail`: off by default. Allowed only with an explicit admin override and the cost warning.
- **Second S3 store** (for example B2, or S3 Glacier Instant Retrieval): a scheduled job copies the object, verifies it, deletes it from the hot store and writes `object_locations(key, store_id, storage_class, size, moved_at)`. The router consults `object_locations` on a miss (4.4), so opening a cold message or file needs no extra step. Classes that need a restore before reading (S3 Glacier Flexible Retrieval, Deep Archive) are refused in v1. A later version could add a "Request restore" action with an ETA.

### 10.3 Rules

A `storage_cold_rules` table holds `(object_class, after_days, min_bytes, target: "r2-ia" | store_id, enabled)`. The pure helper `selectColdCandidates()` (`cold-utils.ts`) is unit-tested. The job runs at 02:00 after the backup and pruning chain in `worker.ts` `scheduled`, and in `server/runtime/scheduler.ts`.

### 10.4 Moving message bodies out of D1 (spike only)

`messages_fts` is an **external-content** FTS5 table kept by UPDATE and DELETE triggers. Clearing body columns would re-index empty text, and an FTS5 delete needs the original values. Body offload therefore requires a separate search-text table, or turning the index into a contentless one, first. Treat it as a two-day spike with a written decision, not as part of this milestone's deliverable.

Tests: unit tests for the age and size rules and for read-through via `object_locations`. An e2e test backdates a seeded message (seed helper), runs the job through a dev-only endpoint, then opens the message, its "original" and its attachment, and searches for it.

---

## 11. External storage (phase 4, outline; needs phase 2)

- **WebDAV first** (Nextcloud, ownCloud, most NAS devices). Table `drive_mounts(id, owner_id, kind: "webdav", label, base_url, username, password sealed, root_path, status, last_error, created_at)`. A mount appears as a linked folder in the Drive nav.
- Operations are proxied: PROPFIND (Depth 1) for listing, GET with Range, PUT streaming (Nextcloud chunked upload v2 for files over 32 MiB), MKCOL, MOVE, DELETE. Nothing is copied into D1. Mounted items have no Kite share links and do not count toward the quota in v1.
- Add a small namespace-tolerant multistatus parser (`webdav-xml-utils.ts`; `src/lib/aws/xml.ts` only has `xmlTag`). Do not add a new dependency.
- Network: Workers can reach only public hosts, which is documented (a NAS needs a public URL or the Node runtime). On Node, LAN access requires `STORAGE_ALLOW_PRIVATE_ENDPOINTS=1`. Store credentials sealed.
- Google Drive and OneDrive come later, each with the install's own OAuth app as in milestone 6.
- Tests: unit tests against a fake WebDAV server (`tests/support/fake-webdav.mjs`). An e2e test links a mount, lists it and downloads a file.

---

## 12. Phased plan, acceptance criteria, tests, estimates

Estimates are in focused engineer-days for one Mission worker, including tests and docs.

### Phase 1: Storage providers (7-9 days)

Deliverables:
- Migration `0060` + backup lists.
- `src/lib/storage/{types.d.ts, object-classes-utils.ts, s3-bucket.ts, s3-presets-utils.ts, router.ts, index.ts, config.ts, validate.ts, health.ts, migration.ts, migration-utils.ts}`.
- `presignAwsUrl` + `UNSIGNED-PAYLOAD` + streaming / `http` / path-style in `src/lib/aws/{sigv4,client}.ts`.
- File bucket multipart, streaming `put` and `list`.
- `withStorage` at every plug-in point.
- CSP `connectSources`.
- Admin Storage page and routes; optional `/api/v1/storage` + MCP tool.
- Docs: `docs/deployment.md` (R2 S3 keys, CORS), `docs/self-hosting.md` (MinIO, env bootstrap), `docs/operations.md`, `docs/privacy.md`, `CLAUDE.md` (a new "Object storage" section), `CHANGELOG.md`, `NOTICE`.

Acceptance:
- With no stores configured, behaviour and per-request D1 reads are unchanged, apart from one cached config read per isolate every 30 s. All existing e2e specs pass.
- An admin adds a MinIO/fake store. The validation checklist reports a missing CORS rule and a wrong secret precisely. Save is refused without `APP_ENCRYPTION_KEY`.
- Routing `mail` to the S3 store makes new inbound mail (through the dev inbound helper), attachments, JMAP uploads and drafts land there. Old messages still open (read chain). A migration copies them, verifies them and completes. The old store is untouched until **Delete from old store** is used.
- A backup routed to S3 is written as multipart and downloads and restores.
- Both runtimes work: `npm run build`, `npm run build:node`, and the Node server with the file bucket default plus an S3 route.

Tests:
- `tests/storage-sigv4-presign.test.mjs`: AWS's published query-string presign example and `UNSIGNED-PAYLOAD` canonical requests.
- `tests/storage-s3-bucket.test.mjs` against `tests/support/fake-s3.mjs`. This is an in-process `node:http` server that verifies SigV4 with a known secret, handles virtual and path hosts, Range, multipart, ListObjectsV2, CopyObject and CORS preflight, and serves recorded fixtures `tests/fixtures/s3/*.xml`: NoSuchKey, AccessDenied, SignatureDoesNotMatch, InvalidPart, and the 200-with-`<Error>` on complete.
- `tests/storage-router.test.mjs` (classification, chain reads, dual delete, cache TTL, config-failure fallback).
- `tests/storage-config.test.mjs` (sealing required, presets, endpoint guard with the dev flags on and off).
- `tests/file-bucket-multipart.test.mjs`.
- Extend `tests/backup-writer.test.mjs` to write through the router and the S3 adapter.
- `tests/storage-migration.test.mjs`.
- `e2e/21-storage-s3.spec.ts`: start the fake S3 on `localhost` (or MinIO when `E2E_S3_URL` is set), add a store, switch mail, migrate, open an old message's original.
- Add `STORAGE_ALLOW_INSECURE_ENDPOINT=1` to `playwright.config.ts` `webServer.env`.

### Phase 2: Drive (10-13 days; ports most of upstream)

Deliverables:
- Migration `0061` + backup lists (new `drive` group).
- `src/lib/drive/*` (ported and adapted), the API routes in section 6, the `(drive)` app, the public page, Save to Drive, account and admin settings, `DRIVE_LINK_RATE_LIMIT`.
- Retention: a daily purge of trash older than `drive_trash_retention_days` and expired uploads, wired into `worker.ts` `scheduled` and `server/runtime/scheduler.ts`.

Acceptance:
- With Drive off (the default), the nav entry is absent, `/drive` shows not-found, `/api/drive/*` returns 404 for signed-in users, and `/d/<any>` and `/api/public/drive/*` return 404.
- The same holds for a user without `can_use_drive` while Drive is on.
- After the switch is turned on and a user is granted access:
  - folder create, rename and move (refused into its own subtree), upload (proxied on the default R2 binding, direct on an S3 store), download with Range, preview of image/PDF/text, and trash → restore → delete forever all work;
  - the quota blocks an upload that would exceed it, and concurrent uploads cannot overshoot;
  - sharing with a second account gives view or edit as specified;
  - a public link with expiry and password works in a fresh browser context with no cookies, returns 404 after revoke or expiry, sends `Content-Disposition: attachment` for HTML and SVG with sandbox CSP, and the page and its JSON show no owner email or session data;
  - All attachments lists mail attachments only from accessible mailboxes, and Save to Drive copies one and counts it against the quota.
- A backup made before migration `0061` restores. A backup after it includes the Drive tables; with contents absent, the content route returns a clear 404.
- Kite, Classic and dark mode are checked.

Tests:
- `tests/drive-utils.test.mjs` (names, inline-safe types, disposition, byte ranges, part plan, quota math, link token hashing and expiry).
- `tests/drive-access.test.mjs` (SQLite: inherited roles, trashed ancestors, public subtree, the recursive CTE).
- `tests/drive-retention.test.mjs`.
- Extend backup coverage and retired-table tests.
- `e2e/22-drive-off-switch.spec.ts`.
- `e2e/23-drive-files.spec.ts` (including `data-style` Classic and dark assertions or screenshots).
- `e2e/24-drive-sharing.spec.ts` (second seeded account; anonymous context for links; header assertions).
- Extend `e2e/support/public-routes.ts`. Extend `e2e/13-security.spec.ts` if it enumerates routes.

### Phase 3: Cold storage (6-8 days, plus a 2-day body-offload spike)

Section 10, with migration `0062`. Acceptance:
- Rules select only matching objects.
- An R2 IA rewrite or a move to a second store keeps messages and files opening without extra steps.
- The settings show the cost text and refuse classes that need a restore.
- The e2e test from 10.4 passes.

### Phase 4: External storage, WebDAV (6-9 days)

Section 11, with migration `0063`. Acceptance:
- Link a WebDAV folder, browse it, download (with Range), upload, rename and delete.
- Bad credentials or an unreachable host show a clear error.
- A private host is refused on Workers.

Total: about 29-39 days, with phases 1 and 2 (about 17-22 days) as the first Mission.

Validation for every phase (from `AGENTS.md`): `npm run check`, `npm run build`, `npm run build:node`, `npm run test:relay:integration`, `npx playwright test`, `npm run quality:check`, `node scripts/docs-check.mjs`. Or run everything with `npm run check:mission`.

---

## 13. Upstream pieces: port / adapt / drop

| Upstream piece | Decision | Notes for Kite |
| --- | --- | --- |
| `src/lib/storage/b2-bucket.ts` (`B2Bucket`, `B2Object`) | **Adapt** → `src/lib/storage/s3-bucket.ts` | generic endpoint and addressing, `http` under the dev flag, streaming with `UNSIGNED-PAYLOAD`, metadata encoding, `list`, `copy`, presign, `storageClass`; keep the 200-with-`<Error>` check |
| `src/lib/storage/index.ts` `withStorage` Proxy + WeakMap | **Port pattern, adapt** | becomes the async, per-class router (4.4) |
| `src/lib/storage/b2-config.ts` (env-only B2/S3 selection) | **Drop as primary; adapt** as the optional `STORAGE_S3_*` bootstrap | Kite config lives in D1, sealed |
| `src/lib/storage/health.ts` `testStorage` | **Port** into `validate.ts` | step 3 of validation |
| `/api/v1/storage`, MCP `manage_storage`, admin scope `storage` | **Adapt (optional in phase 1)** | report routes per class; never return credentials |
| `tests/b2-bucket.test.mjs` | **Adapt** | runs against `fake-s3.mjs` plus recorded fixtures |
| `.dev.vars.example` B2_/S3_ docs, `docs/*` text | **Drop / rewrite** | Admin-first documentation |
| `server/runtime/file-bucket.ts` multipart | **Port** | also add a streaming `put` and `list` |
| Migration `0055_add_drive` (`drive_items`, `drive_shares`) | **Adapt** into `0061` | add `status`, `store_id`, `object_key`, `upload_expires_at`, `source_attachment_id`; key `drive/<id>`; no `link_token` |
| `0056_add_drive_upload_id`, `0057_add_drive_resumable_uploads` | **Adapt** (folded into `0061`) | add `size` to parts; table in `INTERNAL_TABLES` |
| `0058_add_drive_storage_limit` (global per-user cap) | **Adapt** | global switch + default quota + per-user permission and override |
| `0059_add_attachment_trash` (`message_attachments.trashed_at`) | **Drop (v1)** | changes mail semantics (JMAP blobs, the reader, backups); All attachments stays read-only, plus Save to Drive |
| `0060_add_license_seat_limit`, `src/lib/licenses/*` changes, `LicenseIndicator` in the Drive layout, Team/Pro gating in `accounts/utils.ts`, `admin-auth.ts` `canShareAdminMailboxes` | **Drop** | Kite has no licensing (`CLAUDE.md`, "No licensing") |
| `src/lib/drive/access.ts` (roles, chain, descendants, `deleteDriveItems`, `withoutTrashedAncestors`) | **Port, then fix** | recursive CTE instead of N+1; delete uses each row's `store_id` |
| `src/lib/drive/attachments.ts` | **Adapt** | no trash, cursor pagination, Save to Drive |
| `src/lib/drive/categories.ts`, `category-names.ts` | **Port** | |
| `src/lib/drive/content.ts` (`parseByteRange`, `streamDriveFile`) | **Port + extend** | presigned redirect for large downloads; shared disposition helper |
| `src/lib/drive/retention.ts` | **Adapt** | Drive only, configurable days, expired upload abort; hook into `worker.ts` and the Node scheduler |
| `src/lib/drive/storage.ts` (quota sum) | **Adapt** | atomic conditional insert; per-user limit |
| `src/lib/drive/utils.ts` | **Port** | part size 32 MiB proxied / 64 MiB direct; keep `isDriveInlineSafe`, `normalizeDriveName` |
| `src/lib/drive/auth.ts` `authorizeDrive` | **Adapt** → `requireDriveUser` | 404 when off or not permitted |
| `src/app/api/drive/**` routes | **Adapt** | upload flow split into direct and proxied; links API; public API moved to `/api/public/drive/*` |
| `items/[id]/link` + `public/[token]` (plaintext token, no expiry) | **Drop the model, keep the subtree logic** | replaced by `drive_links` (hashed, expiry, password, revoke, rate limit) |
| `api/drive/owners/[id]/avatar` | **Drop** | show initials (`src/lib/avatar-colors.ts`); reuse an existing avatar route only if its access rules fit |
| `src/app/(drive)/*` UI (page, nav, columns, drag, bulk actions, share dialog, type filter, upload, upload panel, cache, preview) | **Adapt** | Kite/Classic/dark, `blue-*`, split utils/types, dialog height rule, link options, direct-upload mode, no i18n JSON |
| `src/app/d/[token]/page.tsx` | **Adapt** | password and expired states; no session, no owner data |
| `security/headers.ts` `frame-src 'self'` | **Already in Kite** | add dynamic `connect-src` for store origins |
| `header-search.tsx`, `mail-search-input.tsx`, `nav-section-header.tsx`, `sidebar-footer.tsx`, `mailbox-selector.tsx` edits | **Adapt minimally** | only the app switcher entry and the Drive search box; avoid broad refactors |
| `src/lib/email/attachments.ts`, `thread-view.ts`, `jmap/*` `trashedAt` filters | **Drop** | follows from dropping attachment trash |
| `src/lib/i18n/en.json`, `docs/localization.md`, `tests/i18n.test.mjs` edits | **Drop** | Kite has no i18n library yet (Milestone 1 item 5) |
| `ui/dialog.tsx` change | **Review**; take only if it fixes a real Kite issue | |
| `.claude/launch.json` | **Drop** | |

Attribution: add a line to `NOTICE` that the storage adapter and Drive modules are derived from Mailflare commits `83ade98`, `9f66e13` and `3c90a03` by Hieu Nguyen (AGPL-3.0). Keep upstream copyright notices if any exist in ported files, and mention the source in the commit messages.

---

## 14. Decisions

Approved by the maintainer on 2026-10-10.

1. A restore keeps the live `storage_stores` / `storage_routes` rows (section 5); the small change to restore planning is accepted.
2. Admins get Drive only through the explicit "Give all accounts access" action, not automatically when the switch is turned on.
3. `system` objects (avatars, branding) stay pinned to the default store in v1.
4. Links always expire; the default maximum is 30 days (`drive_link_max_days = 30`).
5. The dynamic `connect-src` with exact store origins is accepted, so direct browser uploads stay.

Follow-up, not part of this work: tightening the broad `img-src https:` (this design does not need it).

## 15. Mission hand-off checklist

- Read `AGENTS.md`, `CLAUDE.md`, `ROADMAP.md` Milestone 7 and this spec. Use branch `mission/drive-storage`.
- Order: phase 1 (adapter, router, admin) → phase 2 (Drive). Keep phases 3 and 4 as separate Missions.
- Every migration: hand-written SQL, a journal entry, a schema mirror, `npm run db:bundle`, and the backup lists updated in the same commit.
- Every user-visible change: an e2e spec, checked in Kite, Classic and dark mode.
- Every new route: regenerate the docs inventory and OpenAPI. Add public routes to `e2e/support/public-routes.ts`.
- No new runtime dependency (SigV4, XML and WebDAV are hand-rolled as in `src/lib/aws/`).
- Run `npm run check:mission` before handing back. Never deploy, never apply remote migrations, never push `main`.
