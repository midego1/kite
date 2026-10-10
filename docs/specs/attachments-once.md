# Design: store mail attachments once

Status: approved for a Factory Mission; second in order, after [the automatic reading agent](auto-agent.md) and before [Drive and storage](drive-storage.md). Written against `main` at `22b1ac3`; every path below is relative to the repository root.

The migration number below assumes this work lands first. Take the next free number when you start and keep `tests/migration-order.test.mjs` passing.

## 1. Recommendation in one paragraph

Keep the raw `.eml` as the only copy of a received or imported message. Stop writing a second, decoded copy of each attachment: when mail is stored, record where each attachment's encoded body sits inside the raw object (byte offset, length and transfer encoding). Serve the attachment with a ranged R2 read and a streaming base64 decode. A raw-backed row is written only after the bytes decoded from that range have been checked to be identical to what postal-mime produced, so a scanner mistake falls back to today's behaviour instead of serving the wrong file. Attachments that have no raw message behind them (composer uploads, JMAP uploads, outbound mail, forward copies) stay as their own objects. These objects are shared by reference rather than copied when a draft is forwarded or sent. Deleting an attachment row checks whether any other row still uses the object before deleting it. Existing data is converted by an admin-started background job that is resumable and idempotent. A reverse job ("materialize") rebuilds the decoded objects at any time, because the raw is never modified. That reverse job is the rollback path.

This is option D1 below (A with a byte-range index, plus a small part of C). On new inbound and imported mail it reduces storage from about 1.51 GB to about 1.00 GB per GB of mail (-34%). It does not change "download original", DKIM, JMAP blob fidelity or backups. It saves one R2 write per attachment and does not need a new table.

## 2. Verified current state

| Fact | Where |
|---|---|
| The Worker `email` handler stores the raw message at `inbound/<ts>-<id>.eml` | `worker.ts:144` → `src/lib/email/inbound.ts:278-285` |
| Node SMTP, the relay webhook and provider intake store the same key | `src/lib/email/intake.ts:42-46` (callers `server/runtime/smtp.ts:74`, `src/app/api/inbound/route.ts:41`, `src/lib/email/provider-intake.ts:32`) |
| The queue consumer reads the whole raw, parses it with postal-mime and writes each attachment decoded to `attachments/<messageId>/<attId>/<filename>` | `inbound.ts:82-96`, `inbound.ts:196`, `src/lib/email/attachments.ts:58-106` (put at 72-78) |
| The raw is kept for the life of the message; `messages.raw_r2_key` points at it | `inbound.ts:181`, schema `src/db/schema/index.ts:262` |
| IMAP/mbox import writes `imports/<msgId>.eml` and also the decoded attachments | `src/lib/import/service.ts:103`, `:140-150` |
| JMAP `Email/import` writes `drafts/<msgId>.eml` and also the decoded attachments; uploads go to `jmap-uploads/<user>/<id>` | `src/lib/jmap/emails.ts:521-528`, `src/lib/jmap/blobs.ts:17-54` |
| Forwarding copies every attachment object onto the draft (GET and PUT) | `attachments.ts:113-151`, called from `src/app/api/drafts/route.ts:88` |
| Sending a draft reads the draft's objects and writes them again under the sent message; the client then deletes the draft | `src/app/api/send/route.ts:47`, `src/lib/email/send.ts:147`, `src/components/compose/compose-form.tsx:398` |
| The assistant copies attachments by reading and rewriting them | `src/lib/agent/edit-draft.ts:102-124` |
| `message_attachments.r2_key` has a UNIQUE index, so objects cannot be shared today | `src/db/schema/index.ts:394`, `drizzle/migrations/0008_add_message_attachments.sql:14` |
| Inbound raw limit is 25 MiB, attachment limit 25 MB / 10 files | `worker.ts:107`, `attachments.ts:9-11`, `src/lib/email/inbound-attachments.ts` |
| Ranged R2 reads already work on both runtimes | `src/lib/email/unsubscribe.ts:72`; `server/runtime/file-bucket.ts:108-120` |

Storage arithmetic: base64 with 76-column lines stores 3 bytes in 4 plus a CRLF every 76 characters, so decoded bytes are 0.731 of the encoded bytes (measured below). If attachments are 70% of raw bytes, the decoded copies add 0.70 × 0.731 ≈ 0.51 GB per GB of raw. Total: about 1.51 GB stored per GB of mail. Each forward adds another decoded copy (temporarily two). Each send from a draft writes the objects twice and keeps one.

Measured on Node 24 on Apple silicon (a local benchmark script, not in the repository), with a 24.6 MiB raw message carrying an 18.0 MiB base64 attachment:

| Operation | Time | Memory |
|---|---|---|
| `PostalMime.parse` of the whole raw | 220 ms | +136 MiB RSS (above the 128 MB Worker isolate limit) |
| Find the boundaries (`Buffer.indexOf`) | 2.5 ms | none |
| Decode base64 in one call (`Buffer.from(s, "base64")`) | 8 ms | the attachment size |
| Decode base64 as a stream (64 KiB chunks with a 4-character carry) | 30 ms | one chunk |
| SHA-256 of 18 MiB (`node:crypto` / WebCrypto) | 6 / 9 ms | none |

Expect Workers to be 2-3 times slower than these figures. The Worker compatibility flags already include `nodejs_compat`, so `node:buffer` is available on both runtimes.

## 3. Every reader and writer of attachment and raw objects

| Code | Operation | Object | Effect of the recommendation |
|---|---|---|---|
| `attachments.ts:58-106` `storeMessageAttachments` | put | attachment | Changes: shares by `storageId`, does not delete shared keys on rollback |
| `attachments.ts:113-151` `copyMessageAttachments` (forward) | get + put | attachment | Changes: shares object rows; materializes raw rows once |
| `attachments.ts:154-174` `loadMessageAttachmentContents` (send, JMAP submission `jmap/identities.ts:96`, agent approval `agent/approvals/utils.ts:185`) | get | attachment | Goes through the accessor |
| `attachments.ts:177-202` delete one or all for a message | delete | attachment | Deletes rows first and keeps objects that other rows reference; refuses raw rows |
| `attachments.ts:219-246` `getAttachmentForUser` → `app/api/messages/[messageId]/attachments/[attachmentId]/route.ts` (download, preview, inline `cid:` images via `app/(dashboard)/inbox/[messageId]/utils.ts:98-100`), `agent/edit-draft.ts:102` | get | attachment | Accessor returns a stream; the route stops using `object.writeHttpMetadata` |
| `app/api/shared-files/[id]/route.ts:23` (5 MiB link fallback, `email/cloud-attachment-utils.ts:37-41`) | get | attachment | Accessor |
| `agent/approvals/utils.ts:38-47` snapshot digest | get | attachment | Accessor |
| `jmap/blobs.ts:74-90` blob `att` | get | attachment | Accessor |
| `jmap/blobs.ts:91-100` blob of the email, `app/api/messages/[messageId]/original/route.ts:28` | get | raw | Unchanged (the raw is untouched) |
| `email/unsubscribe.ts:72` (header range), `agent/reply.ts:16` (Reply-To) | get | raw | Unchanged |
| `inbound.ts:82`, `inbound.ts:93` (limit reject) | get, delete | raw | Unchanged |
| `email/permanent-delete.ts:33-44` (bulk, empty, trash retention) | delete | both | Rows first, then unreferenced keys (today it deletes objects first) |
| `mailboxes/delete.ts:30-60` purge | delete | both | Attachment keys filtered by reference |
| `email/message-cleanup.ts:7-16` (drafts, templates, JMAP, import rollback, agent) | delete | both | Same reference filter |
| `lib/import/service.ts:140-152` | put | both | Writes raw-backed rows |
| `jmap/emails.ts:338`, `:525` | put | attachment | Unchanged (draft content stays mutable) |
| Search (`search/conditions.ts:22`, `jmap/email-query.ts:136`), thread view, `listMessageAttachments` | metadata only | none | Unchanged |
| Backups (`lib/backups/*`) | JSON of D1 rows only; no R2 objects are copied today | none | New columns flow through; see §7 |
| mbox export (`lib/export/mbox.ts`) | bodies from D1, no attachments | none | Unchanged |
| MCP (`lib/mcp`) | no attachment content | none | Unchanged |
| Node `FileBucket` (`server/runtime/file-bucket.ts`) | get with range, put, delete; `list` throws | | Ranged `body` streams correctly. A ranged `arrayBuffer()` reads the whole file (lines 63-66); fix it in step 2 |

## 4. Options

Savings are in GB stored per GB of raw inbound or imported mail, against today's 1.51.

### A0. Parse the raw on demand with postal-mime
- Savings: about 1.00 (-34%).
- Cost: every download, preview and inline image fetches up to 25 MiB and runs a full parse: about 220 ms and about 136 MiB per request (measured). A message with 10 inline images costs 10 parses. The Cache API is per data centre, does not exist on Node, and cannot be used for private content.
- Verdict: **reject.** The memory alone breaks the Worker on large messages.

### A. Byte-range index into the raw (recommended core)
- Savings: about 1.00 (-34%) for inbound and imported mail. Outbound and draft objects are unchanged. One fewer R2 write (Class A operation) per attachment.
- CPU and latency: at ingest, about 2-5 ms for the scan, plus one base64 decode and a byte comparison per attachment to verify (tens of milliseconds at 25 MB). It removes the per-attachment PUTs. At read time, one ranged GET (same Class B cost as today) and a streaming decode (about 30 ms on Node for 18 MiB; memory bounded by the chunk size). Time to first byte is unchanged.
- Correctness risks:
  - The scanner could find the wrong offsets. A raw-backed row is written only if the range decodes to exactly the postal-mime bytes; otherwise the attachment is stored as an object, as today.
  - The stream decoder could differ from the batch decoder. A unit property test covers this.
  - A reader that bypasses the accessor could serve the whole `.eml` to a share-link recipient, which would disclose the other parts and the headers. To prevent this, raw rows store a sentinel `r2_key` (`raw:<attachmentId>`) that never resolves, and a static test forbids direct `BUCKET.get(<row>.r2Key)` reads.
  - Restoring a backup taken before the conversion would bring back rows that point at deleted objects. A repair on read (lazy repair) and re-running the job fix this.
- Code touched: about 12 files, plus two new modules, one migration, one admin route and one card.
- Effort: medium (about 1.5-2 weeks for one Mission).

### B. Keep decoded attachments and remove them from the raw (store a "skeleton")
- Savings: about 0.81 (-46%): the skeleton is about 0.30 and the decoded copies are 0.51.
- Cost: "download original", the JMAP email blob and every future full backup would have to rebuild the message from N objects plus re-encoding. The ingest path also has to re-encode and compare.
- Correctness risks: the rebuilt message must be byte-identical, or DKIM body hashes, JMAP blob identity and forensic "original" downloads break. This can be checked at ingest by rebuilding and comparing bytes. However, it deletes the only true original. Any later change to the encoder or the skeleton format can silently corrupt the originals of all past mail, and there is no rollback without the original bytes. It also adds lifetime coupling (a skeleton pins blobs), and it makes the roadmap's full backup (`ROADMAP.md:67`) and cold storage (`ROADMAP.md:148-151`) harder.
- Effort: high (about 3-4 weeks), and the migration is destructive.
- Value over A: 12 points of storage. At R2 Standard list price ($0.015 per GB-month above 10 GB free; check current pricing), 100 GB of mail costs about $2.12 a month today, $1.35 with A and $1.07 with B. The extra saving does not justify an irreversible, fidelity-critical rewrite. **Defer.**

### C. Content-addressed dedup with reference counting
- Savings: depends on the workload; it only removes duplicates (forward and send copies, the same file sent to several users). Measure first, using file name, size and type as a stand-in for identical content:
  `SELECT SUM(dup) FROM (SELECT SUM(size) - MAX(size) AS dup FROM message_attachments GROUP BY filename, size, content_type HAVING COUNT(*) > 1)`
  Expect single-digit percentages for most installs.
- Risks: stored reference counts drift when a backup restore replaces rows (§7), and concurrent reuse and delete can race. Use reference queries instead of counts, plus atomic `INSERT … SELECT` reuse. This is what the recommendation takes from C.
- Dedup of raw messages across recipients (the same mail to N local mailboxes stores N raws) is not possible as things stand, because `inboundMessageId` is derived from the raw key (`src/lib/email/inbound-id.ts`, `inbound.ts:56-60`). This is out of scope.
- Effort: low to medium for reference sharing only; medium for full hash dedup.

### D. Combinations
- **D1 = A + reference sharing from C (recommended).** About 1.00 for inbound and imported mail. Forward, send and assistant copies of object attachments cost no bytes and no PUT. Forwarding a raw-backed attachment writes one decoded object, which is deduplicated by SHA-256 within the same user.
- D2 = B + C: about 0.81 minus duplicates, with all of B's risks. Do not start with this one. D1 keeps it possible later.

## 5. Design of D1

### 5.1 Schema (migration `drizzle/migrations/0060_attachment_raw_storage.sql`, written by hand in the generated style)

```sql
ALTER TABLE `message_attachments` ADD `storage` text DEFAULT 'object' NOT NULL;  -- 'object' | 'raw'
ALTER TABLE `message_attachments` ADD `raw_offset` integer;                     -- byte offset of the encoded body in messages.raw_r2_key
ALTER TABLE `message_attachments` ADD `raw_length` integer;                     -- encoded byte length
ALTER TABLE `message_attachments` ADD `transfer_encoding` text;                 -- 'base64' | 'identity'
ALTER TABLE `message_attachments` ADD `sha256` text;                            -- hex digest of the decoded bytes
ALTER TABLE `message_attachments` ADD `storage_checked_at` integer;             -- set when the reclaim job looked at the row
DROP INDEX IF EXISTS `message_attachments_r2_key_unique`;
CREATE INDEX IF NOT EXISTS `message_attachments_r2_key_idx` ON `message_attachments` (`r2_key`);
CREATE INDEX IF NOT EXISTS `message_attachments_sha256_idx` ON `message_attachments` (`sha256`, `size`);
```

Mirror this in `src/db/schema/index.ts:380-400`: drop `.unique()` from `r2Key` and add the columns and indexes. No table is created, renamed or dropped, so `BACKUP_TABLES`, `BACKUP_TABLE_GROUPS` and `DatabaseBackupTable` stay as they are. `npm run db:bundle` regenerates `src/lib/migrations/bundle.json`.

Invariants:
1. `storage='raw'` only for messages whose raw is immutable: `raw_r2_key` starts with `inbound/` or `imports/` and `status <> 'draft'`. JMAP `drafts/` raws and every draft stay `object`, because draft attachments can be removed.
2. A raw row's bytes are `decode(transfer_encoding, raw[raw_offset, raw_offset + raw_length))`, and this was checked at write time to equal the postal-mime bytes exactly (same `size`, same `sha256`).
3. A raw row's `r2_key` is the sentinel `raw:<id>`. The real key always comes from the join to `messages.raw_r2_key`.
4. Raw rows are never shared across messages. Object keys can be shared by several rows. An object is deleted only when no row references its key.
5. Object keys stay unique per write (the current `attachments/<messageId>/<attId>/<filename>` scheme). Reuse copies a key from a live row in one statement, so a key that no row references can never gain a reference again. This keeps delete and reuse free of races without locks.

### 5.2 New modules (types and pure helpers kept in sibling files, per the conventions)

- `src/lib/email/mime-index-utils.ts` (pure, no bindings):
  - `indexMimeParts(raw: Uint8Array)` returns the leaf parts with `{ bodyOffset, bodyLength, transferEncoding, contentType, disposition, filename, contentId }`. It handles header unfolding and RFC 2231 boundary parameters, uses `Buffer.indexOf` for boundaries, applies the RFC 2046 rule that the CRLF before a delimiter belongs to the delimiter, and accepts LF-only line endings, a preamble, an epilogue and a missing close delimiter. It caps nesting at 64 levels and parts at 256.
  - `decodePart(bytes, encoding)` decodes base64 with `node:buffer`; `identity` returns the bytes unchanged.
  - `createBase64DecodeStream()` is a `TransformStream` that strips anything outside the base64 alphabet and carries `length % 4` characters to the next chunk.
  - `matchAttachmentsToParts(attachments, parts)` matches each postal-mime attachment to an unused part whose decoded bytes are byte-equal (candidates are filtered by decoded length first). Unmatched attachments are returned separately.
  - Quoted-printable, uuencode and anything else stay unmatched and are stored as objects, as today.
- `src/lib/email/attachment-storage.ts` (+ `-utils.ts`, `-types.d.ts`):
  - `openAttachment(env, row)` returns `{ body: ReadableStream, size, contentType }`. An `object` row is a plain GET. A `raw` row is `BUCKET.get(rawKey, { range: { offset, length } })` piped through the decoder.
  - `readAttachmentBytes(env, row)` buffers the stream (used by send, forward and the approval digest).
  - Lazy repair: when an `object` row's object is missing and invariant 1 holds, `openAttachment` converts that one message inline (§5.5) and serves the result. It logs `attachment.repaired` with ids only.
  - `storeAttachmentRows(env, { messageId, attachments, raw?, rawKey? })` replaces the body of `storeMessageAttachments`. It writes raw rows for verified matches when the raw-index mode is on, shares `storageId` sources with one statement, `INSERT INTO message_attachments (...) SELECT ?, ?, filename, …, r2_key, 'object', … FROM message_attachments WHERE id = ? AND storage = 'object'`, and otherwise writes a new object. When it rolls back, it deletes only the keys it wrote itself.
  - `deleteUnreferencedObjects(env, db, candidateKeys)` runs after the rows are deleted: `SELECT DISTINCT r2_key FROM message_attachments WHERE r2_key IN (…)` (in chunks with `queryInChunks`), then calls `BUCKET.delete` on the rest in batches of 1,000. It ignores `raw:` sentinels. Put the pure part in `-utils.ts` (generalize `selectDeletableRawKeys` from `src/lib/mailboxes/delete-utils.ts`).

### 5.3 Write paths
- `inbound.ts:196` and `import/service.ts:144` call `storeAttachmentRows` with the in-memory raw buffer and the raw key. In imports, the raw PUT and the row inserts run in parallel today. If either fails, the existing catch deletes the message, and the rows cascade with it.
- `send.ts:147`: attachments loaded from a draft carry `storageId` (`attachments.ts:165`) and are now shared, so a send no longer writes the bytes again. The 5 MiB link fallback still gets a row id (`send.ts:148-150`).
- `copyMessageAttachments`: an object row is shared (row insert only). A raw row is decoded once, then reused within the same user by `sha256, size` if a matching object already exists, or written as a new object.
- `agent/edit-draft.ts:102-124`: passes `storageId` so that the same sharing applies.
- Kill switch: env var `ATTACHMENT_RAW_INDEX` (`on` by default, `off` makes new writes behave as today). Reads always support both layouts. Add it to `env.d.ts`, `wrangler.jsonc.example` and `docs/self-hosting.md`, and have `server/runtime/env.ts` pass it through.

### 5.4 Delete paths (rows first, then unreferenced objects)
- `permanent-delete.ts:33-44`: collect the keys of `object` rows, delete the message rows, then call `deleteUnreferencedObjects` and delete the raw keys. Deleting rows before objects is a deliberate change. If R2 fails afterwards, the cost is an orphaned object, never a missing file that another message still uses (this matches `mailboxes/delete.ts:25-29`). Update the comment and `docs/privacy.md:64`.
- `mailboxes/delete.ts:39-59`, `message-cleanup.ts:13`, `attachments.ts:177-202`: use the same helper. `deleteMessageAttachment` refuses `raw` rows; by invariant 1 they never exist on drafts.

### 5.5 Conversion jobs (existing data)
- `src/lib/email/attachment-storage-jobs.ts` contains `runAttachmentReclaim(env, budgetMs)` and `runAttachmentMaterialize(env, budgetMs)`. They use the queue message `{ kind: "attachments.storage", direction: "reclaim" | "materialize" }` on `OUTBOUND_QUEUE`. Add it to `worker.ts:159-185`, `server/index.ts:64` and `worker-utils.ts:20-26`, and add a type guard. They follow the mailbox purge pattern (a 20 s budget, then the job queues itself again, as in `mailboxes/delete.ts:88-112`).
- State comes from the data, so no persisted cursor is needed. Reclaim selects up to 25 messages that have `object` rows with `storage_checked_at IS NULL` and satisfy invariant 1. For each message:
  1. GET the raw. If it is missing, set `storage_checked_at` and continue.
  2. Index the raw. Take the reference bytes from the existing object, or from a postal-mime parse of the raw when the object is missing (the repair case, matched on file name, size, Content-ID and position).
  3. Run one conditional update per matched row: `UPDATE … SET storage='raw', r2_key='raw:'||id, raw_offset=?, raw_length=?, transfer_encoding=?, sha256=?, storage_checked_at=? WHERE id=? AND storage='object' AND r2_key=?`.
  4. After updates that changed a row, call `deleteUnreferencedObjects(oldKeys)`. A forward draft made before the job keeps its shared object.
  5. Unmatched rows only get `storage_checked_at`.
- Materialize does the reverse for `raw` rows: decode the range, PUT a new object, then `UPDATE … WHERE id=? AND storage='raw'`. If the update matched nothing, delete the object it just wrote. Run materialize before downgrading to a release that predates this change.
- Concurrency guard: `app_settings.attachment_storage_job` (a new JSON column holding `direction`, `startedAt` and `heartbeatAt`) stops a second job chain while the heartbeat is less than 2 minutes old. Running two chains would still be correct, because every write is conditional; the guard only avoids wasted CPU. A restored backup may carry a stale value, and the heartbeat expiry handles that.
- Admin API `src/app/api/admin/attachment-storage/route.ts` (`requireSessionAdmin`; reclaim and materialize require the primary admin, `isPrimaryAdmin`):
  - `GET` returns counts and bytes: object rows eligible to reclaim, raw rows, object rows outside the scope, rows checked but unmatched, and the job state.
  - `GET ?verify=1` runs a HEAD on up to 200 referenced object keys and reports the missing ones.
  - `POST { action: "reclaim" | "materialize" }` starts a job.
  Run `node scripts/docs-generate.mjs` and update `docs/api-inventory.md`.
- UI: `src/components/admin-storage-card.tsx` (+ `-utils.ts`) on `src/app/(admin)/admin/page.tsx`, next to `admin-update-card.tsx`. It shows the space that can be reclaimed before the job runs, the progress, the start button and a "Restore separate copies" action behind a confirmation. Use `blue-*` classes and check the Kite, Classic and dark styles.

### 5.6 Runtimes
- Workers: native R2 ranged GET, `node:buffer` via `nodejs_compat`, queue and cron as listed above.
- Node: `FileBucket.get` with a range already streams the slice. Fix the ranged `FileObject.arrayBuffer()` so it reads only the range (`server/runtime/file-bucket.ts:63-66`). The jobs run on the in-process queue (`server/runtime/queue.ts`). The jobs never need `list`, which `FileBucket` does not implement.

## 6. Security and privacy
- A raw object contains every part and header of a message. It is only ever read through the accessor with an exact range, so share links (`shared-files`) and JMAP `att` blobs cannot return more than the attachment. The sentinel key makes any old or unknown direct reader return 404 instead of the whole message.
- Raw rows are never shared across messages (invariant 4). Deleting a message therefore still removes all of its content. A forward made before the deletion keeps its own decoded object, which is expected because the sent mail contains that file.
- SHA-256 reuse is limited to objects of the same `messages.user_id`, so file content is never linked between accounts.

## 7. Backup and restore (AGENTS.md)
- No table is created, renamed or removed, so the backup lists stay as they are. The new columns travel in the JSON. The restore planner fills missing columns with defaults and drops unknown ones (`src/lib/backups/restore-utils.ts:21`, `:49`), so older backup documents still restore.
- A pre-change backup restored after a reclaim gives rows with `storage='object'` whose objects were deleted. The lazy repair serves them, and running reclaim again converts them. Cover this in an e2e test (step 6) and in `docs/runbooks/recovery.md`.
- A post-change backup restored into a pre-change release: that release drops the new columns and sees `raw:` keys, so attachments return 404. The runbook says to run materialize (and take the backup) before downgrading.
- Reference counts are derived from rows, never stored, so a restore cannot make them drift. This is why C's counters were rejected.
- Roadmap full backup (`ROADMAP.md:67`): it copies the raws plus `object`-storage keys and nothing per raw row, so full backups also get about 34% smaller.

## 8. Implementation plan for a Mission

Use branch `mission/attachments-once`. Run every check in AGENTS.md "How to test" for each step. Never deploy or run remote migrations.

1. **MIME index and decoder (pure).** Add `src/lib/email/mime-index-utils.ts` and `tests/mime-index.test.mjs`, built with esbuild like `tests/permanent-delete.test.mjs`.
   - Fixtures in `tests/fixtures/mime/` (synthetic, `example.com` only, no real PII):
     - multipart/mixed
     - nested related inside alternative inside mixed
     - LF-only line endings
     - base64 with no line breaks, with 64- and 72-column lines, and with trailing spaces
     - quoted and RFC 2231 boundaries
     - folded Content-Type headers
     - a preamble and an epilogue
     - a missing close delimiter
     - two identical attachments
     - message/rfc822 attached as a file
     - a 7bit text attachment
     - quoted-printable and uuencode attachments (expected to stay unmatched)
     - an inline `cid:` image
     - 24 MiB synthetic
   - Acceptance:
     - For every fixture, each postal-mime attachment is either matched to bytes that are exactly equal or reported unmatched, never matched wrongly.
     - Streaming decode equals batch decode for 200 random chunkings.
     - The 24 MiB index and verify takes under 100 ms on CI.
2. **Schema and read accessor.** Migration 0060, the schema, `attachment-storage.ts`, and the `FileBucket` range fix. Route every reader in §3 through `openAttachment` or `readAttachmentBytes`, and drop `object.writeHttpMetadata` from the download route.
   - Add `tests/attachment-storage-boundary.test.mjs`, which fails if any file other than `attachment-storage.ts` and the jobs module passes an attachment row's `r2Key` to `BUCKET.get` (in the style of `tests/route-auth.test.mjs`).
   - Acceptance: no behaviour change (all rows are `object`), and the whole existing suite passes.
3. **Sharing and reference-checked deletion.** §5.3 (sharing parts only) and §5.4.
   - Unit tests for key selection, including shared keys and sentinels.
   - e2e `e2e/21-attachment-storage.spec.ts`: upload to a draft, then send, then delete the draft; the Sent attachment downloads byte-exact. Forward a message with an object attachment, then delete the forward draft; the original still downloads. Permanently delete both; `GET ?verify=1` reports nothing missing.
   - Update `docs/privacy.md` (storage table and deletion order).
4. **Raw-backed ingest.** Inbound and import write raw rows, with the kill switch and the lazy repair.
   - Extend `e2e/support/helpers.ts` `buildMime` (and `helpers-types.d.ts`) with base64 attachments and inline parts.
   - e2e: deliver mail with a PDF and an inline PNG through `deliverInbound`:
     - The inline image renders (`naturalWidth > 0`).
     - Download and preview return the SHA-256 of the fixture.
     - "Show original" is byte-identical to the posted MIME.
     - The JMAP blob download (API key with the `jmap` scope) is byte-exact.
     - A forward and send carries the exact bytes.
     - `GET` status shows the rows as `raw`.
   - Unit test: a quoted-printable attachment falls back to `object`.
5. **Jobs, admin API and UI.** Reclaim, materialize, the queue kind on both runtimes, the route and the card.
   - e2e: materialize changes the counts to all `object` and downloads stay byte-exact; reclaim changes them back to `raw`, the old objects are gone (`verify` reports nothing missing) and downloads stay byte-exact; running reclaim twice does nothing more.
   - Check the card in the Kite, Classic and dark styles.
   - Run a script against `npm run dev` (`scripts/attachment-storage-check.mjs`) that kills the job mid-batch and checks that a re-run converges.
6. **Restore safety.** e2e in `e2e/10-backups.spec.ts`: materialize, take a backup, reclaim, restore that backup; every attachment still downloads byte-exact (lazy repair), then reclaim converges.
   - Unit test: a backup document without the new columns plans valid inserts.
7. **Documentation.** The mail pipeline section of `CLAUDE.md`, `docs/privacy.md`, `docs/runbooks/recovery.md` (materialize before downgrading, reclaim after an old restore), `docs/self-hosting.md` (`ATTACHMENT_RAW_INDEX`), the `ROADMAP.md` full-backup note, and `docs/api-inventory.md`/OpenAPI.

## 9. Acceptance criteria (overall)
- New inbound and imported mail with base64 attachments writes exactly one R2 object (the raw). For the e2e corpus, the bytes stored outside the raw for eligible messages are 0, apart from rows that are explicitly unmatched.
- Every attachment read path (download, preview, inline `cid:`, share link, JMAP blob, forward, send, scheduled send, assistant edit and approval) returns bytes whose SHA-256 equals postal-mime's decoding of the raw.
- "Show original" and the JMAP email blob are byte-identical to the received message.
- A raw row is never served except by decoding its exact range. The sentinel key never resolves.
- Reclaim and materialize are idempotent and resumable, are safe alongside concurrent delivery, forwarding and deletion, and never delete an object that another row references.
- After materialize, a pre-change build reads every attachment.
- After restoring a pre-reclaim backup, every attachment remains readable.
- Both runtimes pass `npm run check`, `build`, `build:node`, `test:relay:integration` and `npx playwright test`.
- The PR description records the Workers CPU p95 for a 25 MB attachment download, taken from the metrics.

## 10. Out of scope and follow-ups
- Option B (removing attachment parts from the raw). Reconsider only if storage cost matters at scale; the raw-range index stays compatible with it.
- Raw dedup across local recipients, which needs a new `inboundMessageId` derivation.
- HTTP `Range` support on attachment downloads (video seeking). This is now cheap for `identity` parts.
- A sweep for orphaned objects (needs `R2Bucket.list`, which `FileBucket` lacks). Orphans only cost money; until the sweep exists, log the keys.
- Unrelated issue seen while reading: `permanentlyDeleteMessages` deletes raw keys without the shared-key check that `mailboxes/delete.ts:46-59` performs. Raw keys are unique per delivery today, so this is harmless, but the helper from §5.2 makes the two consistent.
