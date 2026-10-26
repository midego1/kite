# Spec: search by meaning (semantic search)

Status: **proposed**, not yet approved. Written against `main` at `5c220ba` (release `2026.10.26.1`). Roadmap: proposed [milestone 29](../../ROADMAP.md#milestone-29-search-by-meaning-proposed). Idea adopted from [Zero](https://github.com/Mail-0/Zero) (MIT; the `InboxRag` tool in `apps/server/src/routes/agent/tools.ts`, which is commented out there); no code is ported.

Migrations: the last one on `main` is `0068_add_abuse_ch_auth_key.sql`. This spec claims **`0071_add_semantic_search.sql`**, after [AI writing](ai-writing.md) (`0069`) and [thread summaries](thread-summaries.md) (`0070`), before [assistant by email](assistant-by-email.md) (`0072`). Whichever Mission starts first takes the next free number; keep `tests/migration-order.test.mjs` passing.

New Cloudflare resource: a Vectorize index **`kite-messages`** (binding `VECTORIZE`). No existing resource is renamed.

## 1. Goals and non-goals

Goals:

1. Find mail by what it means, not only by the words in it: "the quote for the roof repair" finds a message titled "Offerte dakwerk", and "when is the dentist" finds the appointment confirmation.
2. Cloudflare Vectorize and Workers AI embeddings on Workers; an equivalent on the Node/Docker runtime.
3. An indexing pipeline that covers new mail, backfill, deletes and trash, with embedding cost under the existing spend caps.
4. Strict scoping: results only from mailboxes the user can read, never across users.
5. Results merged with the existing FTS5 search; a meaning mode for the assistant's `search_emails` tool and MCP.

Non-goals: searching attachment contents (PDF or image text), an answer box that writes an answer from search results (the assistant does that in chat with the tool), semantic search in JMAP, reranking with a second model, cross-encoder scoring, and summaries in the index.

## 2. What exists today

| Area | Where | Relevance |
| --- | --- | --- |
| Full-text search | `messages_fts` (FTS5, external content, migration 0030, kept by three triggers); `buildSearchConditions(raw, timeZone)` in `src/lib/search/conditions.ts` turns the Gmail-style grammar (`query-utils.ts`) into `rowid IN (SELECT rowid FROM messages_fts WHERE … MATCH ?)` plus column filters; `rebuildSearchIndex` / `getSearchIndexStatus` in `index-admin.ts` | Keyword half of hybrid search. Operators (`from:`, `before:`, `has:attachment`, `is:unread`) stay SQL filters. |
| Mail search UI | `src/components/mail-search/mail-search-input.tsx` → `GET /api/messages?q=` (`src/app/api/messages/route.ts`), ordered by date, cursor pagination, conversation view (`group=thread`) | Gains a meaning toggle and relevance order. |
| Module search | `GET /api/search` (`src/app/api/search/route.ts`) returns module sections; "mail results come from the message list" | Unchanged. |
| Chat and MCP tools | `search_emails` and `count_emails` in `src/lib/agent/tools.ts`, scoped by `mailboxFolderConditions` (own drafts only, `screening` excluded); MCP reuses the same tools (`src/lib/mcp/server.ts`, scope `mcp:read`) | `search_emails` gains `mode`. |
| Public API | `GET /api/v1/messages?q=` (`src/app/api/v1/messages/route.ts`) | `mode` added in feature C. |
| JMAP | `Email/query` `text` and `body` filters as `LIKE` (`src/lib/jmap/email-query.ts`) | Unchanged. |
| Access | `listAccessibleMailboxIds` (`src/lib/mailboxes/access.ts`); D1's 100-parameter limit handled by `inJsonArray` and `queryInChunks` (`src/db/chunk-utils.ts`) | The vector filter and the D1 re-check both use the accessible ids. |
| Workers AI | `"ai": { "binding": "AI", "remote": true }` in `wrangler.jsonc` (and in `previews`) | Embeddings on Workers. |
| Node runtime | `server/runtime/env.ts`: no `env.AI`; better-sqlite3 (`^13`), `openKiteQueue`, file bucket; `CF_ACCOUNT_ID` and `CF_TOKEN` may be set for Cloudflare sending | Embeddings through the Workers AI REST API or an OpenAI-compatible endpoint; vectors in a local SQLite file. |
| Spend | `reserveAiSpend` / `reconcileAiSpend` (`src/lib/agent/auto-read/spend.ts`), install cap `agent_daily_spend_cap_micros`, token cap `UNKNOWN_RATES_INPUT_TOKEN_CAP` | Embedding calls reserve like model calls. |
| Queues and cron | `AGENT_QUEUE` (`kite-agent`, `max_batch_size` 1), cron `*/5 * * * *` (Workers) and every minute (Node, `server/runtime/scheduler.ts`) | The indexer drains on both. |
| Triggers precedent | FTS5 triggers (0030), `trashed_at` triggers (0053), [thread summaries](thread-summaries.md) §7.2 | The index queue and delete tombstones are kept by triggers. |
| Backups | `INTERNAL_TABLES` in `src/lib/backups/export.ts`; `messages_fts%` skipped as derived | The index tables are internal. |
| Deploy | Deploy to Cloudflare button (`README.md`, `docs/deployment.md`); Workers Builds on `main` | A new binding affects both (section 10). |

## 3. Zero: what is adopted

Zero's `InboxRag` (commented out in `tools.ts`) embeds a question with `@cf/baai/bge-large-en-v1.5`, queries Vectorize with a metadata filter on the connection, and returns thread ids whose vectors are thread summaries. Adopted: Vectorize with a Workers AI embedding model, and a metadata filter on the owner as a first line of scoping. Not adopted: an English-only model (Kite users write Dutch, German and RTL languages, roadmap milestone 1), vectors of model-written summaries (each would cost a model call per thread; Kite embeds the mail text itself), one vector per thread (long threads blur), and trusting the vector filter alone (Kite re-checks every hit in D1).

## 4. Design

### 4.1 Components

New core directory `src/lib/semantic/` (no module: search is core, like FTS):

- `embedding.ts`: `getEmbeddingProvider(env)` → `{ id, model, dimensions, embed(texts: string[]): Promise<{ vectors: Float32Array[], inputTokens }> }`.
- `vector-store.ts`: the `VectorStore` interface below and `getVectorStore(env)`.
- `vectorize-store.ts` (Workers), `sqlite-vector-store.ts` (Node, in `server/runtime/`, injected through the Node env as `env.VECTORS`), `d1-test-vector-store.ts` (dev and e2e only, section 11).
- `chunk-utils.ts`, `fusion-utils.ts`, `filter-utils.ts` (pure).
- `indexer.ts` (the drain), `search.ts` (query and merge).

```ts
interface VectorStore {
  upsert(items: { id: string; values: Float32Array; mailboxId: string }[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  /** Nearest chunks among the given mailboxes, best first. */
  query(vector: Float32Array, options: { mailboxIds: string[]; topK: number }): Promise<{ id: string; score: number }[]>;
}
```

### 4.2 Embedding model

- **Workers:** `@cf/baai/bge-m3` through `env.AI.run(model, { text: [...] })`, batches of up to 32 texts. Multilingual, 1,024 dimensions, listed by Cloudflare at **$0.0118 per million input tokens** (checked on 2026-10-26; read the current price before release). bge-m3 is chosen over `bge-base-en`/`bge-large-en` because those are English-only, and it is the cheapest of the Workers AI embedding models listed.
- The model is **fixed per install** in this milestone. A Vectorize index has a fixed dimension count, so changing the model means a new index and a full re-embed (open question 5).
- **Node:** the same model through the Workers AI REST API (`POST /accounts/{CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`) when `CF_ACCOUNT_ID` and a `CF_TOKEN` with Workers AI permission are set; otherwise an OpenAI-compatible `/embeddings` endpoint configured by the admin (base URL and key reuse the assistant's compatible provider when it offers embeddings, for example OpenAI `text-embedding-3-small` with `dimensions: 1024`). The provider and model are recorded in `app_settings`; a change triggers a rebuild.
- Workers AI does not report embedding token usage, so Kite counts `ceil(characters / 4)`; the compatible API reports `usage.prompt_tokens`.

### 4.3 Vector stores

**Workers: Vectorize.** Index `kite-messages`, 1,024 dimensions, metric `cosine`, with one metadata index on `mailboxId` (string; Vectorize indexes the first 64 bytes, mailbox ids are shorter). Limits that shape the design (Cloudflare's limits page, checked 2026-10-26): `topK` at most 100 without returned metadata or values (50 with), filter JSON under 2,048 bytes, vector ids at most 64 bytes, metadata indexes must exist **before** vectors are inserted, at most 20,000,000 vectors per index, upserts of up to 1,000 vectors per call from a Worker.

- **Ids.** `<k>:<n>`, where `k` is the first 32 hex characters of SHA-256 of the message id and `n` the chunk number, so ids stay under 64 bytes whatever the message id format. `message_embeddings.vector_key` stores `k` with an index for the reverse lookup. Queries ask for ids only (`returnMetadata: "none"`), which allows `topK` 100.
- **Scoping filter.** `{ mailboxId: { $in: [...] } }`. Mailbox ids are about 30 bytes, so the filter is split into groups of at most 40 ids (`filter-utils.ts` checks the encoded size), one query per group in parallel, merged by score.
- **Metadata.** Only `mailboxId`. No subject, sender or text is stored in Vectorize.

**Node: weighing the two options.**

| | Brute force in JavaScript over a SQLite file | sqlite-vec (`vec0` virtual table) |
| --- | --- | --- |
| Dependency | None (better-sqlite3 is already there) | A native SQLite extension loaded with `db.loadExtension`; prebuilt binaries per platform and libc, which the Docker image must ship |
| Maturity | Plain code Kite owns | Pre-1.0, format may change |
| Search | Exact nearest neighbours | Also exact (no ANN index), in C with SIMD: faster by a constant factor |
| Scoping | Read only rows of the accessible mailboxes (indexed `mailbox_id`) | Partition key on `mailbox_id` |
| Size per chunk | 1,024 bytes with int8 quantisation (scale per vector) | 4,096 bytes as float32, or 1,024 bytes as `int8` vectors |
| Speed for a user with 100,000 chunks in scope | One scan of ~100 MB of int8 data; about 0.2–0.5 s (estimate; measure in the spike) | Several times faster |

**Recommendation:** brute force first, as `sqlite-vector-store.ts` over a separate file `data/vectors.sqlite` (table `vectors(id TEXT PRIMARY KEY, mailbox_id TEXT, scale REAL, data BLOB)`, index on `mailbox_id`), int8-quantised, scanned in pages of 5,000 rows with a running top-K. It needs no new dependency, keeps vectors out of the main database (so its backups and the D1 schema are untouched) and is fast enough for the mailbox sizes self-hosters run. sqlite-vec can replace it behind the same interface if measurements show a need (open question 4). A self-hosted install that later runs on libSQL (roadmap milestone 7, item 5) could use libSQL's native vector type instead.

### 4.4 What is embedded

For each eligible message, `buildEmbeddingText` (pure, `chunk-utils.ts`):

- A header: `Subject:`, `From:` (name and address), `To:` (first three), `Date:` (ISO date), and `Attachments:` (file names only).
- The text: `htmlToReadableText` of the body (or `text_body`), with quoted replies removed (lines starting with `>`, the part after a `wrapQuotedHtml` marker or an `On … wrote:` line), whitespace collapsed.
- **Chunking:** about 1,500 characters (~400 tokens) per chunk, split at paragraph then sentence boundaries, 200 characters of overlap, the header repeated at the top of every chunk, at most **8 chunks** per message (the first ~12,000 characters). Text after that is still found by keyword search.
- **Eligible:** status `received`, `sent` or `archived`, in a mailbox whose `semantic_index` is on, with spam verdict other than `spam`. Never `draft` (private to its author), `spam`, `trash`, `screening`, `template`, `queued` or `failed`.

### 4.5 Indexing pipeline

**State.** `message_embeddings` (one row per message, section 7) holds `pending | running | indexed | skipped | failed`, the vector key, the chunk count, a content hash, the model, attempts and a lease.

**Enqueueing by triggers**, so every path that creates or changes mail (inbound, send, JMAP import, IMAP import, Screener approval, a restore, moving out of Spam or Trash) is covered without code in each:

- `AFTER INSERT ON messages` when the new status is eligible and `app_settings.semantic_search_enabled = 1` → `INSERT OR IGNORE` a `pending` row.
- `AFTER UPDATE OF status ON messages` when the new status is eligible and the old one was not → `INSERT OR IGNORE` a `pending` row (a row already `indexed` stays, its vectors still exist).
- `AFTER DELETE ON messages` → copy `vector_key` and `chunk_count` into `message_embedding_deletes`, then delete the state row. (The state table has no foreign key to `messages` so that this trigger can still read it.)

Messages moved to Spam or Trash keep their vectors until they are deleted for good; search re-checks status in D1, so they never show. Trash retention and mailbox purges delete the rows, and the tombstones remove the vectors.

**Draining.** `processEmbeddingBatch(env)`:

1. Gates: `semantic_search_enabled`, `agent_enabled`, a configured embedding provider; an external (compatible) provider also needs `agentExternalAutoReadAllowed`, re-read on every batch.
2. Claim up to 32 `pending` rows (or `running` rows whose lease expired) with one `UPDATE … SET status = 'running', lease_until = ? WHERE message_id IN (SELECT … ORDER BY queued_at DESC LIMIT 32) RETURNING …`, newest first so new mail is searchable before old mail is.
3. Load the messages, re-check eligibility (a row whose message became ineligible is set `skipped`), build chunks.
4. Reserve spend (section 8); none left → release the claim and stop.
5. Embed in one call per 32 texts; `upsert` the vectors; set `indexed` with the content hash and chunk count. On a provider error: `attempts + 1`, back to `pending` until 3 attempts, then `failed` with the error code (no content).
6. Delete vectors whose chunk count shrank, and drain up to 1,000 tombstones per run with `deleteByIds`.

**Triggering the drain.** After `processInboundMessage` and `sendEmail` store a message, they send `{ kind: "search.embed" }` on `AGENT_QUEUE` (cheap and idempotent: the claim makes duplicate messages no-ops). Every cron tick also runs up to 4 batches on Workers and 2 on Node, which is what moves a backfill along: about 128 messages per 5 minutes on Workers, roughly 37,000 a day, within the spend rules below. A separate queue binding is not added; the agent queue's batch size of 1 keeps embedding work from delaying triage for long.

**Backfill.** Turning the feature on starts it: each cron tick inserts `pending` rows for up to 5,000 more eligible messages, newest first, from a cursor in `app_settings.semantic_backfill_cursor` (the `created_at, id` of the oldest message queued so far) until no message is left. Admin shows progress (indexed / eligible), the estimated cost to finish and **Pause**.

**Rebuild.** **Rebuild index** in Admin sets every row back to `pending`; upserts overwrite the same ids. **Clear stale vectors** lists Vectorize ids page by page (1,000 per page) and deletes those whose key is not in `message_embeddings`, for an index left with orphans after a restore into a different database.

### 4.6 Querying and merging with FTS5

`semanticSearch({ user, mailboxIds, query, folderConditions, timeZone })` in `search.ts`, used by `/api/messages`, `search_emails` and `/api/v1/messages`:

1. `parseSearchQuery` splits operators from free text. **No free text** (only operators) → the existing keyword path, unchanged.
2. **Keyword hits:** the free text through FTS5 ranked by `bm25(messages_fts)`, top 100 rowids, joined to the same scope conditions as today.
3. **Meaning hits:** embed the free text (one call, a few tokens; skipped when the text is shorter than 3 characters), query the store with the accessible mailbox ids (or the selected mailbox), `topK` 100, map chunk ids back to message ids keeping each message's best chunk, and drop hits below a minimum similarity (cosine 0.45 to start; tuned in the spike).
4. **Fusion:** reciprocal rank fusion, `score = Σ 1 / (60 + rank)` over both lists (`fusion-utils.ts`), so a message found by both ranks highest and neither score scale dominates.
5. **The D1 re-check is the guarantee:** the fused ids are loaded with `inArray` (through `queryInChunks`) **and** every condition the keyword search applies: accessible mailbox ids, folder and status, `ne(status, SCREENING_STATUS)`, drafts only of the user, and the operators (`from:`, `before:`, `has:attachment`, `is:unread`) as SQL. A vector hit that fails any of them is dropped; the store's filter only narrows the candidates.
6. Return at most 50 messages in fused order, each with `match: "keyword" | "meaning" | "both"`. Hybrid results have no cursor; **Show more** continues with keyword results by date.

When semantic search is off, not ready, the provider fails or a cap is reached, step 3 is skipped and the response says `semantic: "unavailable"` with a reason; search never fails because of the meaning half.

## 5. Access scoping

- **Two layers.** The store query is restricted to the accessible mailbox ids (Vectorize metadata filter, or the SQLite `mailbox_id` index). Every hit is then re-checked in D1 under the exact conditions of the keyword search (4.6 step 5). A bug in either layer alone cannot show another user's mail.
- **No content in the store.** Vectors carry only a key and `mailboxId`. Message ids, subjects and snippets come from D1 after the re-check.
- **Shared mailboxes.** A mailbox is indexed once; anyone who can read it can find its mail, exactly as with keyword search. A mailbox manager can switch **Search by meaning** off for a mailbox (`mailbox_agent_settings.semantic_index`); its pending rows are skipped and its vectors deleted.
- **Drafts** are never embedded, so one user's draft cannot surface for another through a shared mailbox.
- **MCP keys** are limited to their `mcp_key_mailboxes`, which become the `mailboxIds` passed to the store.

## 6. API, tools and UI

- **`GET /api/messages`:** `q` with free text uses hybrid search when the install has it on and the user has not turned it off for the request (`semantic=0`). Rows gain `match`. Response gains `semantic: "on" | "unavailable"` and `semanticReason`.
- **`search_emails`** (chat and MCP): new optional `mode: "keyword" | "meaning" | "both"`; default `both` when available, otherwise `keyword` with a `note` in the result when `meaning` was asked for and is unavailable. The description says when to use meaning ("for questions about topics, not exact words"). `count_emails` stays keyword-only, because a count by meaning has no clear answer. MCP scopes are unchanged (`mcp:read`).
- **`GET /api/v1/messages`:** `mode=hybrid` (feature C), documented in `docs/openapi.json` through `node scripts/docs-generate.mjs`.
- **JMAP:** unchanged; `Email/query` keeps its `text` filter. A vendor capability can follow.
- **Mail search box:** a **By meaning** chip in `mail-search-input.tsx`, on by default when available, remembered per browser (`appearance-preferences.ts`). Results are ordered by relevance with a **Sort by date** switch; meaning-only hits get a small "related" mark so a result without the typed words does not look like a bug.
- **Admin → Agent → Search by meaning** (primary admin): enable, embedding provider and model (Node), progress, estimated cost, Pause, Rebuild index, Clear stale vectors, and the daily share of the spend cap the backfill may use.
- **Settings → Assistant**, per mailbox (`canManage`): **Include this mailbox in search by meaning**.

All routes are session routes through `requireSessionUser` (admin ones through `requireSessionAdmin(env, request, isPrimaryAdmin)`); `e2e/13-security.spec.ts` picks them up.

## 7. Data model and migration

`0071_add_semantic_search.sql` (hand-written, journal entry), schema in `src/db/schema/semantic.ts`:

`message_embeddings`

| Column | Type | Notes |
| --- | --- | --- |
| `message_id` | text PK | No foreign key (the delete trigger needs the row; section 4.5) |
| `mailbox_id` | text | For skipping excluded mailboxes |
| `vector_key` | text NOT NULL | First 32 hex of SHA-256(message id); index |
| `status` | text `pending \| running \| indexed \| skipped \| failed` | |
| `chunk_count` | int default 0 | |
| `content_hash` | text | SHA-256 of the embedded text and model; skip re-embedding when unchanged |
| `model` | text | |
| `attempts` | int default 0 | |
| `error` | text | A code, never content |
| `lease_until`, `queued_at`, `indexed_at` | timestamp | |

Indexes: `(status, queued_at)`, `(mailbox_id)`, `(vector_key)`.

`message_embedding_deletes`: `vector_key` text, `chunk_count` int, `created_at`; drained by the indexer.

Also: the three triggers of 4.5; `app_settings` columns `semantic_search_enabled` (default 0), `semantic_embedding_provider` (`workers_ai | compatible`, nullable), `semantic_embedding_model`, `semantic_backfill_cursor`, `semantic_backfill_paused` (default 0), `semantic_backfill_cap_share` (percent, default 50); `mailbox_agent_settings.semantic_index` (default 1).

**Before the migration:** `semantic_search_enabled` cannot be read, so search is keyword-only and Admin shows "Apply the database update". The `app_settings` and `mailbox_agent_settings` columns are read through `selectRow` (`src/lib/db/pending-columns.ts`).

## 8. Cost and spend caps

- Every embedding batch reserves with `reserveAiSpend` (source `embedding`, `mailboxId` null, the estimated tokens and the embedding model's rate) against the install cap; query embeddings reserve as source `embedding_query` with the user's selected mailbox. Without a rate for the model, the token cap applies, as for triage.
- **Backfill gives way to everything else:** the drain claims backfill rows only while today's total `ai_usage` is below `semantic_backfill_cap_share` (default 50%) of the install cap. New mail is indexed until the full cap. Search itself never stops working: without budget, it is keyword-only.
- The embedding model's rate goes into `agent_model_rates` (the catalog fetch already loads Workers AI prices; if it lacks the embedding model, the admin enters it).

Estimates with bge-m3 at $0.0118 per million tokens, ~600 tokens of embedded text per message on average (header plus up to 8 chunks; most mail is one chunk):

| Workload | Tokens | Cost |
| --- | --- | --- |
| Backfill of 10,000 messages | ~6 M | ~$0.07 |
| Backfill of 100,000 messages | ~60 M | ~$0.71 |
| 200 new messages a day | ~120,000 | ~$0.0014 a day |
| 1,000 searches a day | ~15,000 | < $0.001 a day |

Vectorize bills stored and queried dimensions separately from Workers AI; at 100,000 messages (~150,000 chunks × 1,024 dimensions) storage is about 154 M stored dimensions. Check Vectorize pricing before release and show both estimates in Admin. The Workers paid plan's included allowances cover a typical single-organisation install.

## 9. Security and privacy

- **Embeddings are mail content.** Text can be partly reconstructed from embeddings, so vectors are treated like the mail itself: same provider exposure, deleted with the message, never exported.
- **Where text goes.** On Workers with Workers AI and Vectorize, text and vectors stay on Cloudflare in the install's own account. A compatible embedding provider receives the text of **every** indexed message and every search query, so it needs the external opt-in (`agentExternalAutoReadAllowed`), re-checked on every batch and every query; the Admin page names the provider. The Workers AI REST API from Node counts as Cloudflare.
- **Query text** goes to the embedding provider. That is new: keyword search never left the install. The search box tooltip and `docs/privacy.md` say so.
- **Injection.** Embeddings are not instructions; a hostile message can at most push itself up the results for some queries. Results are mail rows the user could already open.
- **Docs.** `docs/privacy.md` ("What is stored where": Vectorize index or `data/vectors.sqlite`; "Deletion": with the message, the mailbox switch, or turning the feature off, which deletes the index contents), `docs/operations.md` (index status, rebuild), `docs/deployment.md` (section 10).

## 10. wrangler.jsonc and the Deploy button

- Add to `wrangler.jsonc` at the top level and in `previews` (previews already share the production D1 and bucket, so they share the index):

  ```jsonc
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "kite-messages" }],
  ```

  Regenerate `cloudflare-env.d.ts` with `npm run cf-typegen`; never edit it by hand.
- **Deploy button.** Cloudflare's documentation lists Vectorize among the resources the button provisions (checked 2026-10-26). The spike must confirm that it creates the index with 1,024 dimensions and the cosine metric, and whether it can create the `mailboxId` metadata index. If not, `docs/deployment.md` gets a step: `npx wrangler vectorize create kite-messages --dimensions=1024 --metric=cosine` and `npx wrangler vectorize create-metadata-index kite-messages --property-name=mailboxId --type=string`, before the first deploy. These are operator commands, run by the operator, never by a Mission.
- **Existing installs (including production).** A Worker whose configuration binds an index that does not exist fails to deploy. The index (and its metadata index) must therefore be created **before** the release that adds the binding is merged; the CHANGELOG entry of that release names this as an operator action. Michiel decides whether to accept this one-time step or to reach Vectorize through its REST API with `CF_TOKEN` instead of a binding, which avoids the deploy dependency at the cost of latency and a wider token (open question 1).
- Installs that never turn the feature on still need the index to exist once the binding is in the configuration; it stays empty.

## 11. Both runtimes and development

| | Workers | Node/Docker | Dev server and e2e (workerd, no credentials) |
| --- | --- | --- | --- |
| Embeddings | `env.AI` (bge-m3) | Workers AI REST API, or compatible `/embeddings` | The fake model's new `/embeddings` endpoint as a compatible provider (loopback, `AI_ALLOW_INSECURE_LOOPBACK`) |
| Vectors | Vectorize binding | `data/vectors.sqlite`, brute force | `d1-test-vector-store.ts`: brute force over a table created at runtime, only when `SEMANTIC_TEST_STORE=1` and `NODE_ENV !== "production"`, injected by the `vite.config.ts` customizer for `serve` and set in `playwright.config.ts` (like `ALERT_WEBHOOK_ALLOW_INSECURE`) |
| Queue and cron | `AGENT_QUEUE`, `*/5` cron | `openKiteQueue("agent")`, per-minute scheduler | As Workers |

Vectorize has no local emulation in `wrangler dev` without remote access, which is why development and e2e use the test store. `search.embed` is added to `env.d.ts`, `worker.ts` `queue()`, `server/index.ts`, `worker-utils.ts` and `tests/queue-log-context.test.mjs`. `npm run build:node` must pass; the Node store is in `server/runtime/` and is never imported by app code (it arrives through the env).

## 12. Backups

- `message_embeddings` and `message_embedding_deletes` go into `INTERNAL_TABLES` with a comment: derived from `messages` and rebuilt by the triggers. They are not in any group or in `DatabaseBackupTable`.
- Vectors (Vectorize, `data/vectors.sqlite`) are not backed up.
- **After a restore** the `AFTER INSERT` trigger queues every restored eligible message again (when the feature is on), so the index rebuilds itself at embedding cost, newest first and within the backfill share of the cap. Vectors of the same message ids are overwritten; orphans from mail not in the restored database never pass the D1 re-check and are removed by **Clear stale vectors**.
- Tests: a restore re-queues eligible messages and not drafts or spam; a backup does not contain the two tables.

## 13. Rollout and flags

- Off by default for every install (`semantic_search_enabled = 0`). The primary admin turns it on in Admin; the backfill starts on the next cron tick. Mailboxes are included by default and can be excluded.
- The CHANGELOG for the release names migration 0071, the new binding and the operator step of section 10, and links Admin → Agent with an app path (`docs/releasing.md`).
- Search falls back to keyword-only whenever anything is missing, so turning the feature off (which also deletes the index contents after a confirmation) is safe at any time.

## 14. Tests

### 14.1 Unit

- `semantic-chunks.test.mjs`: header, quote removal, 1,500-character chunks with overlap, 8-chunk cap, eligibility.
- `semantic-fusion.test.mjs`: reciprocal rank fusion order, ties, a message in both lists ranks first, `match` labels.
- `semantic-filter.test.mjs`: the Vectorize filter stays under 2,048 bytes and splits into groups; vector ids stay under 64 bytes.
- `semantic-sqlite-store.test.mjs` (better-sqlite3, temporary file): int8 quantisation keeps the top-10 order of a float32 reference on fixtures; scoping returns only the given mailboxes; delete removes.
- `semantic-triggers.test.mjs` (`SqliteDatabase`): insert, status change into and out of Spam, Trash and `screening`, draft insert, delete (including a cascaded delete when a user is removed) produce the right `pending` rows and tombstones; the triggers do nothing while the feature is off.
- `semantic-scope.test.mjs`: the D1 re-check drops hits from other mailboxes, other users' drafts and `screening` rows even when the store returns them.
- `semantic-spend.test.mjs`: backfill stops at the cap share; live indexing continues to the cap; external provider without the opt-in embeds nothing.
- Backup tests: the two tables are internal; `queue-log-context` for `search.embed`.

### 14.2 e2e (`e2e/56-semantic-search.spec.ts`; take the next free number)

The fake model gains `POST /embeddings` returning deterministic vectors: words are mapped through a small synonym table (`invoice`/`bill`/`factuur`, `roof`/`dak`, `dentist`/`tandarts`) and hashed into 1,024 dimensions, so "meaning" matches are predictable. It records requests.

1. Turn the feature on, deliver messages, wait for indexing; searching "bill" finds the message that says "invoice" (match `meaning`) and the one that says "bill" (`keyword` or `both`) first.
2. A second user with their own mailbox: neither user's search ever shows the other's message, also when the fake store would rank it first.
3. Spam, a screened message and another user's draft in a shared mailbox never appear.
4. Delete a message: it disappears from results and a tombstone is drained.
5. Chat `search_emails` with `mode: "meaning"` returns the invoice message.
6. Turn off the mailbox switch: its messages leave meaning results; keyword search still finds them.
7. Spend cap reached: search still answers, keyword-only, with `semantic: "unavailable"`.
8. The By meaning chip and labels in Kite, Classic and dark mode.

## 15. Sizing

Work on `mission/semantic-search`; the usual validation (`npm run check:mission`).

| Feature | Work | Acceptance | Size |
| --- | --- | --- | --- |
| **A. Spike** | Deploy-button provisioning of the index, the metadata index on an existing install, bge-m3 quality on Dutch and English mail, Vectorize latency with `$in` filters, Node brute-force timings on 100,000 chunks | A short report in the PR; open questions 1 and 4 answered with numbers | 1 day |
| **B. Pipeline** | Migration 0071, triggers, `message_embeddings`, the drain, the Vectorize and test stores, embedding providers, spend, backfill, tombstones, the binding and docs | New and backfilled mail is indexed within the caps; deletes remove vectors | 4 days |
| **C. Search** | `semanticSearch`, fusion, D1 re-check, `/api/messages`, `search_emails` and MCP `mode`, `/api/v1` `mode`, the search chip, e2e 1–8 | Section 4.6 and 5 behaviour; keyword search unchanged when off | 3 days |
| **D. Node and Admin** | `data/vectors.sqlite` store, REST and compatible embeddings, Admin page (progress, pause, rebuild, clear stale), mailbox switch | Same behaviour on Node; `npm run build:node` passes | 2–3 days |

Total: about 10 to 11 working days.

## 16. Place in the roadmap

- **After** [AI writing](ai-writing.md) and [thread summaries](thread-summaries.md), which are smaller and need no new Cloudflare resource; and after the approved [storing attachments once](attachments-once.md).
- **Before** milestone 6 (external mail accounts) is completed at scale, or together with it: a large IMAP import becomes a large backfill, and the cap share of section 8 is what keeps it from crowding out automatic reading.
- **With** milestone 7, item 5 (own database): on libSQL the Node store can move to native vectors.
- **Independent of** [assistant by email](assistant-by-email.md), which benefits from `search_emails` by meaning once both exist. The "more chat actions" work being built now does not change `search_emails`.

## 17. Open questions for Michiel

1. Accept the one-time operator step of creating the `kite-messages` index before the release that adds the binding (production included), or use the Vectorize REST API with `CF_TOKEN` instead of a binding?
2. Is sending search queries to the embedding provider acceptable by default when the provider is Workers AI, with the external opt-in required otherwise (as specified)?
3. Should embedding count against the same install spend cap as the assistant (as specified, with backfill limited to a share), or get a cap of its own?
4. Node: brute force first (recommended), or sqlite-vec from the start?
5. Fix the model to bge-m3 for every install (as specified), or let admins choose, at the cost of a new index and a full re-embed per change?
