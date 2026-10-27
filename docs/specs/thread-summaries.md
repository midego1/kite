# Spec: thread summaries (Summarize button and one-line list summaries)

Status: **proposed**; its open questions were decided by Michiel on 2026-10-26 (section 17). Written against `main` at `5c220ba` (release `2026.10.26.1`). Roadmap: proposed [milestone 28](../../ROADMAP.md#milestone-28-thread-summaries-proposed). Idea adopted from [Zero](https://github.com/Mail-0/Zero) (MIT; `apps/server/src/lib/thread-short-summary.ts` and its summarize prompts); no code is ported.

Migrations: the last one on `main` is `0068_add_abuse_ch_auth_key.sql`. This spec claims **`0070_add_ai_summaries.sql`**, after [AI writing](ai-writing.md) (`0069`) and before [semantic search](semantic-search.md) (`0071`) and [assistant by email](assistant-by-email.md) (`0072`), which are specified at the same time. Whichever Mission starts first takes the next free number; keep `tests/migration-order.test.mjs` passing. **Implemented as `0072_add_ai_summaries.sql`** (0070 went to the writing style, and 0071 is claimed by the install telemetry pull request); every `0070` below means that migration. Feature A shipped in #137; feature B (one-line summaries) follows it. Two details differ from the text below: the line's daily limit counts the requests that asked for a line today (`ai_usage` sources `line_summary` and `auto_triage_line`, whether or not a usable line came back), and a triage request that asked for a line but got none does not queue a second request, so a message is never summarised twice.

## 1. Goals and non-goals

1. **Summarize in the reader.** A **Summarize** button for a conversation or a single message, run on demand, cached, and marked out of date when a new message arrives in the conversation.
2. **One-line summaries in the message list.** Optional, per mailbox: a summary of at most 140 characters shown instead of the preview for mail that qualifies, with cost controls, and without doing the work twice when automatic reading already reads the message.
3. Storage and a migration; spam, trash and Screener exclusion; mailbox access checks; spend through the existing caps.

Non-goals: summaries of attachments (PDF text, images), summaries pushed by email or webhook, summarising whole folders or a daily digest, backfilling one-line summaries for old mail, translating mail, and a summary API for `/api/v1`, MCP or JMAP (section 9).

## 2. What exists today

| Area | Where | Relevance |
| --- | --- | --- |
| Triage summary | `TriageResult.summary` (≤ 280 characters) in `src/lib/agent/auto-read/triage-utils.ts`; `wantsSummary` in `policy-utils.ts` plans a `summary` suggestion only for threads of at least 3 messages (`SUMMARY_MIN_THREAD_MESSAGES`) or bodies over 1,500 characters (`SUMMARY_MIN_BODY_CHARS`), when `capabilities.summary` is on | A summary of the **latest message** with thread subjects, made only when automatic reading calls the model. The one-line summary reuses that call (section 5.3). |
| Reader card | `src/components/agent/suggestion-card-body.tsx` shows the `summary` suggestion's text at the top of the card | The Summarize result must not appear twice next to it (section 4.4). |
| Thread data | `GET /api/messages/[id]/thread`; `loadDraftThread` (`src/lib/agent/jobs/draft-generation.ts`, the last 20 messages); `messages.thread_id`, index `messages_mailbox_thread_key_idx` on `(mailbox_id, coalesce(thread_id, id))` | The thread key and the window. |
| Message list | `GET /api/messages` (`src/app/api/messages/route.ts`) returns `snippet` per row, `threadMessageIds` in conversation view, and `agentSuggestions` from one extra query over the page | `lineSummary` is added the same way. |
| Statuses | `received` (Inbox and folders), `sent`, `archived`, `draft` (private to its author), `spam`, `trash`, `screening` (`SCREENING_STATUS`, `src/lib/screener/screener-utils.ts`), module statuses such as `template`; `spam_verdict` `inbox \| suspicious \| spam` | Only `received`, `sent` and `archived` are ever summarised. |
| Access | `getMailboxAccessLevel` (`src/lib/mailboxes/access.ts`): `read_only < send_on_behalf < send_as < full_access`; `ownMessage` in `src/lib/agent/tools.ts` hides another user's draft | Reading a summary needs `canRead`; making one too (section 6). |
| Model, spend, opt-in | `getAgentModel`; `withReservedSpend` and `reserveAiSpend` (`auto-read/spend.ts`); `selectAutoReadModel` re-checks `agentExternalAutoReadAllowed` per request; [AI writing](ai-writing.md) §5.6 adds `selectInteractiveModel` for clicked requests, which also requires the opt-in | Every request here needs the opt-in when the provider is not Workers AI. |
| Jobs | `scheduleAgentWork` (`auto-read/schedule.ts`) and `triageMessageGate`; `processAgentTriageJob` (`process.ts`); `AGENT_QUEUE` (`kite-agent`), `agent_jobs` with `kind`; the Screener's approval schedules automatic reading (`src/lib/screener/service.ts`) | The one-line job is a new `agent_jobs` kind. |
| Model extension precedent | Module triage model extensions (`model-extension-utils.ts`): an optional key in the one triage request, raising `maxOutputTokens`, leaving the request byte-for-byte unchanged when inactive | The one-line field uses the same pattern as a core extension. |
| Realtime | `notifyUsersOfNewMessage`, `src/lib/realtime/types.d.ts`, `src/hooks/use-message-polling.ts` | A `message_summary` event refreshes the row. |
| Triggers on `messages` | FTS5 triggers (migration 0030) and `trashed_at` triggers (0053) | A trigger drops conversation summaries when a message leaves the conversation (section 7.2). |

## 3. Zero: what is adopted

Zero stores a long thread summary as Vectorize metadata and condenses it into one or two sentences with a small model, cached in R2 under a key that includes the long summary (`thread-short-summary.ts`), so it is recomputed only when the thread is re-summarised. Its prompt editor has separate Summarize thread, Re-summarize thread and Summarize message prompts.

Adopted: a short summary keyed by what it summarises, so a changed conversation invalidates it; separate thread and message summaries; per-task summary instructions (Kite's `summary_instructions`, [AI writing](ai-writing.md) §6). Not adopted: storing summaries in Vectorize metadata or R2, a second model call to shorten a long summary (Kite asks for the line directly), and summarising every thread in the background.

## 4. Summarize in the reader

### 4.1 Behaviour

- The reader's thread toolbar (`src/components/messages/conversation-thread.tsx`) gets **Summarize** (Sparkles icon). In conversation view, or when the conversation has more than one eligible message, it summarises the conversation; on a single message, or from a message's own menu (**Summarize this message**), it summarises that message.
- The result is a card at the top of the reader: a one- or two-sentence overview, then up to five short points under fixed labels chosen by the model from **Asks**, **Decisions**, **Dates** and **Next steps**. Plain text only, never HTML. A footnote says "Written by AI (<model>), may be wrong", with **Copy** and **Hide**.
- A cached summary opens instantly on any later visit, for every user who can read the mailbox, with no model call.
- **Out of date:** when the conversation changed since the summary was made (a new message arrived, one was sent, or one was moved to Spam or Trash), the card shows the old text greyed with "New messages since this summary" and **Summarize again**. Kite never regenerates on its own.
- **Translate to <language>:** when the summary's language differs from the user's language (4.5), the card offers **Translate to Dutch** (the language named with `Intl.DisplayNames`). It runs on demand and is cached next to the summary.
- **Not offered** for a conversation with no eligible message (section 7.1), for a message in Spam, Trash or the Screener, and when the assistant is off or no provider is configured. The button is disabled with a reason when a cap or the rate limit is reached.

### 4.2 Input and output

What the model receives:

- The last **20** eligible messages of the conversation, oldest first. Each is From, date, direction and the text from `htmlToReadableText` with quoted replies removed (lines starting with `>` and the quoted part after a `wrapQuotedHtml` marker or an `On … wrote:` line), cut at 2,500 characters; at most 24,000 characters in total, newest kept first. Earlier messages appear only as one line each (From, date, subject).
- Each message in its own untrusted block with one nonce per request, through `wrapUntrusted` from [AI writing](ai-writing.md) §5.4 (`src/lib/agent/untrusted-utils.ts`, extracted from `triage-utils.ts`), with `markUntrustedLinks`.
- System prompt: a constant (`SUMMARY_SYSTEM_MARKER` in `request-markers.ts`), then the mailbox's general `instructions` and `summary_instructions`, then the clicking user's personal general and summary instructions, each under its "cannot override these rules" heading, as in AI writing §6.2.

What Kite accepts (pure `src/lib/agent/summaries/summary-utils.ts`):

- One JSON object `{ language, overview, points: [{ label, text }] }`, parsed strictly with one repair turn, like triage. `language` is a lower-case ISO 639-1 code (`/^[a-z]{2}$/`, else `und`). The texts are plain text: Markdown stripped (`stripDraftMarkdown`), the overview at most 400 characters, at most 5 points of at most 200 characters each, 1,200 in total.
- No email address or URL that does not occur in the summarised messages (`draft-guard-utils.ts`); an offending point is dropped.
- A reply that is empty or meta text ("Here is a summary…") is retried once, then shown as an error.

Language: the language of the conversation (decision 6), reported by the model as `language`. Summary instructions can still ask for another language; the reported `language` then says which one was used.

Model call: `generateText`, no tools, `maxRetries: 0`, `maxOutputTokens` 400, provider options of `buildModelCallOptions` for kind `draft`. Not streamed: the answer is short and must pass the checks before it is shown or cached.

### 4.3 Caching and invalidation

A summary is cached per mailbox in `ai_summaries` (section 7.3) with a **coverage digest**: the SHA-256 (first 16 hex characters) of the sorted ids of the eligible messages it covered. On every read, Kite computes the current digest for the conversation with one indexed query over `(mailbox_id, coalesce(thread_id, id))`; a different digest means out of date. This catches every way a conversation changes (inbound delivery, a sent reply, a JMAP import, a move to Spam or Trash, a Screener approval) without a hook in each path.

The cache is shared by everyone who can read the mailbox. That is safe because drafts, the only per-user messages, are never summarised, so every reader sees the same eligible messages.

Personal summary instructions ([AI writing](ai-writing.md) §6.1) change what the model is asked, so the cache key includes an `instructions_digest`: the first 16 hex characters of SHA-256 over the clicking user's personal general and summary instructions, or `''` when both are empty. Users without personal instructions share one summary per conversation; a user with them gets their own row. The mailbox's instructions are not in the key: changing them leaves existing summaries in place until the next **Summarize again**.

### 4.4 Next to the automatic-reading summary

The triage `summary` suggestion summarises the latest message; the button summarises the conversation. When a summary made by the button is current, the reader card hides the triage summary line (the suggestion itself stays, so For you still lists it), so the reader never shows two summaries. When the button summary is out of date, the triage summary shows again. Both stay (decision 9); whether to retire the triage `summary` kind is revisited after launch.

### 4.5 Translating a summary

**The user's language.** Kite has no language setting yet: `users` stores `time_zone` but no language, the module call context's `locale` defaults to `"en"` (`buildCallContext` in `src/lib/modules/capability-utils.ts`), and Money Watch formats amounts with `navigator.language` in the browser (`src/components/finance/use-subscriptions.ts`). So the reader sends the primary subtag of `navigator.language` (`nl` from `nl-NL`) as `language` with the summary requests. A per-user language setting is a follow-up; it belongs with the interface translations of roadmap milestone 1, item 5, and takes precedence over the browser once it exists. An `und` summary, or one whose language equals the user's, offers no translation.

**The request.** `POST /api/messages/[id]/summary` with `{ scope, translateTo }`. The input is only the cached summary (overview and points) in one nonce block, never the mail; the answer has the same JSON shape and the same output checks, with `language` forced to the target. Gates are the Summarize button's: the assistant on, the external-provider opt-in for a non-Cloudflare provider (AI writing §5.6), `canRead`, the `summary:<userId>` rate limit and a spend reservation (source `summary_translation`) against the mailbox and install caps.

**The cache.** A row of the same `kind`, `thread_key`, `message_id`, `coverage_digest` and `instructions_digest` as its source, with `language` set to the target and `translation_of` pointing at the source row (`ON DELETE CASCADE`). It is current only while its source is; when the source is replaced by **Summarize again**, the old translation goes with it, and the card offers to translate the new summary. The triggers of 7.2 remove translations together with their source.

## 5. One-line summaries in the message list

### 5.1 Behaviour and settings

- Per mailbox, under assistant **Settings → Summaries** (people with `canManage`): **One-line summaries in the message list** (off by default), **Include newsletters and notifications** (off by default) and a **daily limit** (default 100, 1 to 1,000 messages per UTC day).
- In the list, a qualifying message with a summary shows it in place of the preview, in the same style, with a small Sparkles mark and the preview in the tooltip. Per browser, **Show AI summaries instead of previews** (`src/components/appearance-preferences.ts`, on by default) turns the display off without touching the mailbox setting.
- In conversation view the row shows the line of the newest message in the conversation that has one.
- New mail only. A summary arrives a few seconds after the message; a realtime `message_summary` event updates the row.

### 5.2 Which mail qualifies

All of these, checked in a pure `lineSummaryGate` (`summaries/gate-utils.ts`):

- Inbound, status `received` (Inbox or a folder), delivered less than 30 minutes ago (no backfill), or released by a Screener approval (the newest 20 released messages per approval).
- Spam verdict `inbox` (not `suspicious` or `spam`); no open phishing suggestion. A confident summary of a phishing message would launder it, so such mail keeps its plain preview.
- Not `screening`; not from a muted sender (`capabilities.mutedSenders`); not from the mailbox's own addresses.
- At least 280 characters of text (shorter mail already fits in the preview).
- Not bulk, automatic or no-reply mail (`facts-utils.ts`: `List-Id`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders), unless **Include newsletters and notifications** is on.
- Under the mailbox's daily limit (counted from completed one-line jobs and triage jobs that wrote a line, since 00:00 UTC).

### 5.3 One model call per message, never two

- **When automatic reading reads the message with the model** (autonomy is not `off` and `needsModel` is true), the line comes from the same triage request. While the mailbox has one-line summaries on and the message qualifies, the triage request carries a core extension, built like a module model extension (auto-agent §5.4): an optional `oneLine` string property (≤ 140 characters, "a single line for a message list, without links or addresses") in the provider schema, one instruction line before the closing rule, and 60 more output tokens. `parseTriageOutput` keeps it leniently (an invalid value is dropped and never triggers the repair turn). Without the setting the triage request is byte-for-byte what it is today.
- **Otherwise** (autonomy `off`, or triage decided not to call the model, for example for a newsletter with **Include newsletters** on), a separate job of the new `agent_jobs` kind `line_summary` runs one small request: the latest message only (subject and 4,000 characters of text in one untrusted block), `maxOutputTokens` 80, the mailbox's `triage_model_id` (the cheapest configured model, as for triage). The triage job decides at its end whether a line is still needed and enqueues it; when no triage job is created at all, `scheduleAgentWork` enqueues the line job itself. The unique index on `agent_jobs (mailbox_id, source_message_id, kind)` keeps it at one job per message.
- **Not a third source:** the triage `summary` (≤ 280) is not shortened into a line by another call.

The line job is processed by the existing agent queue consumer with the same lease, retry (3 attempts) and recovery as other kinds; it records `skipped` with a reason when a gate fails.

### 5.4 Gates and spend for the line

The line is background work, so it uses the automatic-reading rules: `agent_enabled`, the install switch `agent_auto_read_enabled`, `selectAutoReadModel` (so an external provider needs **Allow external provider for automatic reading**, re-checked per request), `paused_until` on the mailbox, the per-mailbox burst limit (`allowAutoReadRequest`), and `withReservedSpend` with source `line_summary` against the mailbox and install spend caps. A refused line is skipped with the same reason codes Activity already explains.

## 6. Access

- `GET` and `POST` on a summary need `canRead` on the mailbox of the message, through `getMailboxAccessLevel`, and the message must be readable under the `ownMessage` rule (another user's draft answers 404). Mail of a mailbox the user cannot read answers 404, so ids do not leak.
- Making or translating a summary is allowed to read-only users of a shared mailbox too (decision 7), since it shows nothing they cannot read; it is charged to the mailbox and stops at the mailbox's spend cap and the install cap.
- The list's `lineSummary` is returned only on rows the existing list query already scoped to accessible mailbox ids.
- Rate limit: `AGENT_RATE_LIMIT` with key `summary:<userId>`.

## 7. Data model and migration

### 7.1 Eligible messages

Status `received`, `sent` or `archived`, in the same mailbox and conversation (`coalesce(thread_id, id)`). Never `draft`, `spam`, `trash`, `screening`, `template`, `queued` or `failed`, and never a message with spam verdict `spam`. A conversation that mixes eligible and other messages is summarised from the eligible ones only.

### 7.2 Removing summaries with their content

A summary repeats what the messages said. When a message is deleted or moves to Spam or Trash, the conversation summaries that covered it must go too, or deleted content would live on in them:

- `message` and `line` rows reference `messages(id)` with `ON DELETE CASCADE`.
- Two triggers in the migration remove `thread` rows of the conversation: `AFTER DELETE ON messages` and `AFTER UPDATE OF status ON messages WHEN new.status IN ('spam','trash')`, each running `DELETE FROM ai_summaries WHERE kind = 'thread' AND mailbox_id = old.mailbox_id AND thread_key = coalesce(old.thread_id, old.id)`. The same `UPDATE` trigger also deletes the moved message's own `message` and `line` rows.
- **Saving is conditional**, because the triggers only remove rows that already exist: a message deleted or trashed while its summary is being generated would otherwise come back in the answer saved afterwards. The upsert of a `thread` or `message` row (and of a translation, against its source row) is one statement, `INSERT … SELECT … WHERE (SELECT count(*) FROM messages, json_each(?) WHERE messages.id = json_each.value AND messages.status IN ('received','sent','archived') AND coalesce(messages.spam_verdict, '') <> 'spam') = ?`, with the covered ids bound as one JSON array (`inJsonArray`, `src/db/chunk-utils.ts`) and their count. D1 runs a single statement atomically, so either every covered message is still eligible when the row is written or nothing is written. With zero changes the answer is discarded (its spend is still reconciled), and the route answers 409 `conversation_changed`, which the card shows as "The conversation changed; summarize again". A `line` row is written the same way against its one message.
- `src/lib/maintenance/pruning.ts` deletes `thread` rows that have been out of date for 30 days.

### 7.3 Table

`0070_add_ai_summaries.sql` (hand-written, journal entry), schema in `src/db/schema/agent-summaries.ts`:

`ai_summaries`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | `newId("sum")` |
| `mailbox_id` | text, FK `mailboxes` CASCADE | |
| `kind` | text `thread \| message \| line` | |
| `thread_key` | text NOT NULL | `coalesce(thread_id, id)` of the message |
| `message_id` | text, FK `messages` CASCADE, nullable | Set for `message` and `line`; null for `thread` |
| `text` | text NOT NULL | `thread`/`message`: JSON `{ overview, points: [{ label, text }] }`; `line`: the line |
| `coverage_digest` | text NOT NULL | Section 4.3 (for `line` and `message`, the message id's digest) |
| `covered_count` | int | Messages covered |
| `source` | text `button \| triage \| line_job` | |
| `model` | text | |
| `language` | text NOT NULL | ISO 639-1 code of `text`, or `und` |
| `translation_of` | text, FK `ai_summaries` CASCADE, nullable | Set on a translation (4.5) |
| `instructions_digest` | text NOT NULL DEFAULT `''` | Section 4.3 |
| `created_by_user_id` | text, FK `users` SET NULL | Null for background lines |
| `created_at`, `updated_at` | timestamp | |

Indexes: unique `(mailbox_id, kind, thread_key, coalesce(message_id, ''), instructions_digest, language)` (upserted, so a regeneration replaces the row; the upsert first deletes the replaced row's translations with `DELETE FROM ai_summaries WHERE translation_of = <old id>`, because an upsert updates in place and never fires the `ON DELETE CASCADE` that 4.5 relies on); `(message_id)`; `(translation_of)`.

Also in `0070`:

- `mailbox_agent_settings`: `list_summaries` boolean default 0, `list_summaries_bulk` boolean default 0, `list_summary_daily_limit` int default 100.
- `agent_jobs.kind` gains the value `line_summary` (the column is plain text, so only the TypeScript enum changes).
- The triggers of 7.2.

**Before the migration is applied:** reads of `ai_summaries` that fail with a missing table answer `{ summary: null, migrationPending: true }` and the button is hidden; `POST` answers 409 `MIGRATION_PENDING`; the three settings columns are read through `selectRow` (`src/lib/db/pending-columns.ts`), as [AI writing](ai-writing.md) §6.3 does for its columns, so a stale database behaves as "one-line summaries off".

## 8. API

All session routes use `requireSessionUser` (never `requireUser`); mutations check `hasValidSessionMutationOrigin`.

- `GET /api/messages/[id]/summary?scope=thread|message` → `{ summary: { scope, overview, points, stale, createdAt, model } | null, eligible: boolean, reason?: "not_eligible" | "assistant_off" | "no_provider" }`.
- `POST /api/messages/[id]/summary` `{ scope }` → the same shape after generating, or 429 (`rate_limited`, `spend_cap`), 403 (`assistant_off`), 409 (`MIGRATION_PENDING`). A current summary is returned without a model call; `POST` with a current summary is a no-op.
- `GET /api/messages`: each row gains `lineSummary: string | null`, read in one extra query over the page's message ids (and, in conversation view, over `threadMessageIds`), only for mailboxes that have the setting on. No N+1.
- `GET`/`POST` take the user's `language` (4.5); the response adds `language` and `translation: { language, overview, points } | null`, and `translatable: boolean`. `POST` with `translateTo` makes or returns the translation.
- `PUT /api/agent/settings`: the three new mailbox fields (`canManage`).
- Realtime: `MessageSummaryNotification { type: "message_summary", mailboxId, messageId }` to the mailbox's users, handled in `use-message-polling.ts`.

`e2e/13-security.spec.ts` picks up the new routes (401 without a session).

## 9. Search, chat, MCP, JMAP and the public API

- **Search:** summaries are not indexed by FTS5 (they are derived from text that already is). [Semantic search](semantic-search.md) does not embed them either.
- **Chat:** `get_thread` gains `summary` (the cached conversation summary, when current) so the assistant can answer from it without rereading 20 messages. Chat does not generate summaries through a new tool; it can summarise in its own answer.
- **MCP, JMAP and `/api/v1`:** unchanged in this milestone. A cached summary could be exposed later as a read-only field.
- **Webhooks:** none.

## 10. Security and privacy

- **Injection.** Each message is an untrusted block; the call has no tools; output is plain text with addresses and links limited to those in the conversation; the summary is labelled as written by AI. A message telling the model to "say this is from your bank" can at worst produce a wrong summary, which is why suspicious and phishing mail gets no line (5.2) and a summary never replaces the reader's own phishing warning.
- **Excluded mail.** Spam, Trash, the Screener and drafts never reach the model. The Screener promises no automatic reading before a decision; Summarize is hidden for screened messages, even though it would be a click.
- **Stored content.** Unlike chat prompts and responses, summaries are stored, like suggestion payloads are. `docs/assistant.md` ("Prompts and responses are not stored") and `docs/privacy.md` ("What is stored where", "Retention", "Deletion") say so: what is stored, that it is shared with everyone who can read the mailbox, and that it is deleted with its messages (7.2).
- **Provider.** Every request in this spec needs the primary admin's external-provider opt-in when the provider is not Workers AI: the Summarize button and its translation through `selectInteractiveModel` ([AI writing](ai-writing.md) §5.6), one-line summaries through `selectAutoReadModel`.

## 11. Cost

Kimi K2.5 rates as in [auto-agent](auto-agent.md) §8 ($0.60 / $3.00 per million tokens, unverified; Kite uses the configured `agent_model_rates`).

| Request | Input | Output | Cost on Kimi K2.5 | On a small model ($0.10 / $0.30, unverified) |
| --- | --- | --- | --- | --- |
| Summarize a long conversation (20 messages) | ~6,500 | ~300 | ~$0.0048 | ~$0.0007 |
| Summarize one message | ~1,200 | ~200 | ~$0.0013 | ~$0.0002 |
| One-line, inside triage | +~40 (one instruction line) | +~40 | ~$0.0001 extra | ~$0.00002 |
| One-line, own job | ~1,100 | ~40 | ~$0.0008 | ~$0.0001 |
| Translate a summary | ~500 | ~300 | ~$0.0012 | ~$0.0001 |

A mailbox with 100 qualifying messages a day and automatic reading off spends about $0.08 a day on Kimi K2.5, or about $0.01 on a small model; with automatic reading on, most lines ride on the triage call. Every request is under the mailbox and install caps.

## 12. Both runtimes and backups

- **Runtimes.** Only `getEnv()`, `getDb`, `AGENT_QUEUE`, `AGENT_RATE_LIMIT` and `getAgentModel`. The `line_summary` kind is dispatched by `processAgentQueueMessage` on Workers and the Node `agent` queue, typed in `env.d.ts`, named in `worker-utils.ts` and covered by `tests/queue-log-context.test.mjs`. SQLite triggers behave the same on D1 and better-sqlite3. On Node a compatible provider (with the opt-in) is needed for one-line summaries.
- **Backups.** `ai_summaries` is derived data and is **skipped** (decision 10): it goes into `INTERNAL_TABLES` in `src/lib/backups/export.ts` with a comment saying so, and into no group and not into `DatabaseBackupTable`. A restore replaces the messages, which removes the old summaries through the cascade and the triggers of 7.2, so the restored install starts with none: Summarize makes them again on demand, and one-line summaries reappear for new mail only. Tests: a backup does not contain the table; a restore leaves it empty; the coverage check does not report it.

## 13. Rollout and flags

- No new install-wide flag: the button follows the assistant switch; one-line summaries follow the automatic-reading install switch, its external-provider opt-in and caps, and are off per mailbox until someone turns them on.
- The CHANGELOG names migration 0070 and links the assistant settings with an app path (`docs/releasing.md`).
- Feature A can ship before AI writing; without `summary_instructions` the prompt omits that heading.

## 14. Tests

### 14.1 Unit

- `summary-eligibility.test.mjs`: statuses, verdicts, Screener, drafts; the 20-message window and the 24,000-character budget; quoted text removed.
- `summary-digest.test.mjs`: the digest changes on a new, moved or deleted message and not on a read or star change.
- `summary-output.test.mjs`: the JSON shape and `language` code, plain text, Markdown stripped, limits, unknown links dropped, meta replies refused, labels limited to the four.
- `summary-language.test.mjs`: the primary subtag of the browser language; translation offered only when the languages differ and neither is `und`; the `instructions_digest` is `''` without personal instructions.
- `line-summary-gate.test.mjs`: every rule in 5.2, including the daily limit and the newsletter switch.
- `triage-line-extension.test.mjs`: with the setting off, `buildTriagePrompt` and `buildTriageJsonSchema` equal today's fixtures; with it on, `oneLine` is present, the output cap is 60 higher, and a bad `oneLine` never fails the parse.
- A `SqliteDatabase` test for the 7.2 triggers: delete and trash remove `thread` rows of that conversation only; a summary saved after one of its covered messages was deleted or trashed writes nothing and reports `conversation_changed`.
- Backup tests: `ai_summaries` is internal; `tests/queue-log-context.test.mjs` for the queue message `{ kind: "agent.line_summary", jobId }`.

### 14.2 e2e with the fake model (`e2e/55-thread-summaries.spec.ts`; take the next free number)

New fake scenarios: `summary-thread`, `summary-hostile` (Markdown, an unknown link, "Here is"), and a `oneLine` field in the triage scenarios.

1. Deliver a three-message conversation; **Summarize** shows the overview and points; reopening shows it with no new fake-model request.
2. Deliver a fourth message; the card says "New messages since this summary"; **Summarize again** makes one request.
3. A message in Spam and a screened message show no button; the route answers `not_eligible`.
4. A read-only user of a shared mailbox sees the cached summary, and can make one for another conversation; its `ai_usage` row carries the mailbox.
5. `summary-hostile`: no Markdown, no unknown link.
6. Mailbox with automatic reading at Suggest and one-line summaries on: the line appears in the list without a reload, and the fake model recorded **one** request for that message (the triage request, carrying `oneLine`).
7. Autonomy off and one-line summaries on: one `line_summary` request; a newsletter (`List-Id`) gets none until **Include newsletters** is on; daily limit 1 stops the second.
8. Move a summarised conversation's message to Trash: the conversation summary is gone.
9. The card in Kite, Classic and dark mode.
10. A Dutch conversation read in an English browser offers **Translate to English**; the translation request contains only the summary; reopening shows the cached translation; **Summarize again** after a new message drops it.
11. A user with personal summary instructions gets a separate summary; a user without them sees the shared one.

## 15. Sizing

Work on `mission/thread-summaries`; the same validation as every Mission (`npm run check:mission`).

| Feature | Work | Acceptance | Size |
| --- | --- | --- | --- |
| **A. Summarize button** | Migration 0070, `ai_summaries`, triggers, summary utils, `GET`/`POST /api/messages/[id]/summary`, reader card and toolbar button, translation (4.5), the triage-summary rule of 4.4, `get_thread.summary`, backups (internal), docs, e2e 1–5, 8–11 | Section 4 behaviour, cache shared and invalidated, translations cached with their source, nothing excluded reaches the model | 4–5 days |
| **B. One-line summaries** | Settings and columns, `lineSummaryGate`, the triage core extension, the `line_summary` job, list field, realtime event, appearance preference, Screener release hook, e2e 6–7 | One model call per message at most; gates and caps apply | 3 days |

## 16. Place in the roadmap

- **After** [AI writing](ai-writing.md) (shared untrusted-block helper, `summary_instructions`, `selectInteractiveModel`). Feature A can go first if needed, with those pieces built here instead.
- **Before** [semantic search](semantic-search.md) and [assistant by email](assistant-by-email.md); the assistant by email can answer "summarise my unread mail" by reading cached summaries.
- **Interacts with** milestone 20 (unified mailbox): one-line summaries are per mailbox, so the combined view shows them per row as is. The "more chat actions" work being built now does not touch summaries.

## 17. Decisions (2026-10-26, Michiel)

6. Summaries are written in the **conversation's language**. When that differs from the user's language, the card offers **Translate to <language>** on demand, under the same spend and opt-in rules, cached next to the summary (4.5). The user's language is the browser's for now; a language setting is a follow-up.
7. **Read-only users** of a shared mailbox may trigger summaries, within the mailbox cap (6).
8. **Newsletters are not** in one-line summaries by default; a per-mailbox switch turns them on (5.1).
9. The automatic-reading `summary` suggestion **stays**; revisit after launch (4.4).
10. Summaries are **skipped in backups** as derived data (`INTERNAL_TABLES`, section 12).

The numbers follow the combined list of decisions for the four specs. No open questions remain.
