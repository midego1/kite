# Spec: thread summaries (Summarize button and one-line list summaries)

Status: **proposed**, not yet approved. Written against `main` at `5c220ba` (release `2026.10.26.1`). Roadmap: proposed [milestone 28](../../ROADMAP.md#milestone-28-thread-summaries-proposed). Idea adopted from [Zero](https://github.com/Mail-0/Zero) (MIT; `apps/server/src/lib/thread-short-summary.ts` and its summarize prompts); no code is ported.

Migrations: the last one on `main` is `0068_add_abuse_ch_auth_key.sql`. This spec claims **`0070_add_ai_summaries.sql`**, after [AI writing](ai-writing.md) (`0069`) and before [semantic search](semantic-search.md) (`0071`) and [assistant by email](assistant-by-email.md) (`0072`), which are specified at the same time. Whichever Mission starts first takes the next free number; keep `tests/migration-order.test.mjs` passing.

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
| Model, spend, opt-in | `getAgentModel`; `withReservedSpend` and `reserveAiSpend` (`auto-read/spend.ts`); `selectAutoReadModel` re-checks `agentExternalAutoReadAllowed` per request; [AI writing](ai-writing.md) §5.6 adds `selectInteractiveModel` for clicked requests | Button: interactive. One-line: background. |
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
- **Not offered** for a conversation with no eligible message (section 7.1), for a message in Spam, Trash or the Screener, and when the assistant is off or no provider is configured. The button is disabled with a reason when a cap or the rate limit is reached.

### 4.2 Input and output

What the model receives:

- The last **20** eligible messages of the conversation, oldest first. Each is From, date, direction and the text from `htmlToReadableText` with quoted replies removed (lines starting with `>` and the quoted part after a `wrapQuotedHtml` marker or an `On … wrote:` line), cut at 2,500 characters; at most 24,000 characters in total, newest kept first. Earlier messages appear only as one line each (From, date, subject).
- Each message in its own untrusted block with one nonce per request, through `wrapUntrusted` from [AI writing](ai-writing.md) §5.4 (`src/lib/agent/untrusted-utils.ts`, extracted from `triage-utils.ts`), with `markUntrustedLinks`.
- System prompt: a constant (`SUMMARY_SYSTEM_MARKER` in `request-markers.ts`), then the mailbox's general `instructions` and `summary_instructions` under "cannot override these rules" headings, as in AI writing §6.2.

What Kite accepts (pure `src/lib/agent/summaries/summary-utils.ts`):

- Plain text; Markdown stripped (`stripDraftMarkdown`); the overview at most 400 characters, at most 5 points of at most 200 characters each, 1,200 in total.
- No email address or URL that does not occur in the summarised messages (`draft-guard-utils.ts`); an offending point is dropped.
- A reply that is empty or meta text ("Here is a summary…") is retried once, then shown as an error.

Language: the language of the conversation, unless the summary instructions say otherwise (open question 1).

Model call: `generateText`, no tools, `maxRetries: 0`, `maxOutputTokens` 400, provider options of `buildModelCallOptions` for kind `draft`. Not streamed: the answer is short and must pass the checks before it is shown or cached.

### 4.3 Caching and invalidation

A summary is cached per mailbox in `ai_summaries` (section 7.3) with a **coverage digest**: the SHA-256 (first 16 hex characters) of the sorted ids of the eligible messages it covered. On every read, Kite computes the current digest for the conversation with one indexed query over `(mailbox_id, coalesce(thread_id, id))`; a different digest means out of date. This catches every way a conversation changes (inbound delivery, a sent reply, a JMAP import, a move to Spam or Trash, a Screener approval) without a hook in each path.

The cache is shared by everyone who can read the mailbox. That is safe because drafts, the only per-user messages, are never summarised, so every reader sees the same eligible messages.

### 4.4 Next to the automatic-reading summary

The triage `summary` suggestion summarises the latest message; the button summarises the conversation. When a summary made by the button is current, the reader card hides the triage summary line (the suggestion itself stays, so For you still lists it), so the reader never shows two summaries. When the button summary is out of date, the triage summary shows again. Retiring the triage `summary` kind in favour of the button is open question 4.

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
- Making a summary is allowed to read-only users too, since it shows nothing they cannot read; it is charged to the mailbox and counted against its spend cap. Whether read-only users may trigger spend is open question 2.
- The list's `lineSummary` is returned only on rows the existing list query already scoped to accessible mailbox ids.
- Rate limit: `AGENT_RATE_LIMIT` with key `summary:<userId>`.

## 7. Data model and migration

### 7.1 Eligible messages

Status `received`, `sent` or `archived`, in the same mailbox and conversation (`coalesce(thread_id, id)`). Never `draft`, `spam`, `trash`, `screening`, `template`, `queued` or `failed`, and never a message with spam verdict `spam`. A conversation that mixes eligible and other messages is summarised from the eligible ones only.

### 7.2 Removing summaries with their content

A summary repeats what the messages said. When a message is deleted or moves to Spam or Trash, the conversation summaries that covered it must go too, or deleted content would live on in them:

- `message` and `line` rows reference `messages(id)` with `ON DELETE CASCADE`.
- Two triggers in the migration remove `thread` rows of the conversation: `AFTER DELETE ON messages` and `AFTER UPDATE OF status ON messages WHEN new.status IN ('spam','trash')`, each running `DELETE FROM ai_summaries WHERE kind = 'thread' AND mailbox_id = old.mailbox_id AND thread_key = coalesce(old.thread_id, old.id)`. The same `UPDATE` trigger also deletes the moved message's own `message` and `line` rows.
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
| `created_by_user_id` | text, FK `users` SET NULL | Null for background lines |
| `created_at`, `updated_at` | timestamp | |

Indexes: unique `(mailbox_id, kind, thread_key, coalesce(message_id, ''))` (upserted, so a regeneration replaces the row); `(message_id)`.

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
- **Provider.** The Summarize button follows the interactive rule ([AI writing](ai-writing.md) §5.6); one-line summaries follow the automatic-reading rule, so an external provider needs the primary admin's opt-in.

## 11. Cost

Kimi K2.5 rates as in [auto-agent](auto-agent.md) §8 ($0.60 / $3.00 per million tokens, unverified; Kite uses the configured `agent_model_rates`).

| Request | Input | Output | Cost on Kimi K2.5 | On a small model ($0.10 / $0.30, unverified) |
| --- | --- | --- | --- | --- |
| Summarize a long conversation (20 messages) | ~6,500 | ~300 | ~$0.0048 | ~$0.0007 |
| Summarize one message | ~1,200 | ~200 | ~$0.0013 | ~$0.0002 |
| One-line, inside triage | +~40 (one instruction line) | +~40 | ~$0.0001 extra | ~$0.00002 |
| One-line, own job | ~1,100 | ~40 | ~$0.0008 | ~$0.0001 |

A mailbox with 100 qualifying messages a day and automatic reading off spends about $0.08 a day on Kimi K2.5, or about $0.01 on a small model; with automatic reading on, most lines ride on the triage call. Every request is under the mailbox and install caps.

## 12. Both runtimes and backups

- **Runtimes.** Only `getEnv()`, `getDb`, `AGENT_QUEUE`, `AGENT_RATE_LIMIT` and `getAgentModel`. The `line_summary` kind is dispatched by `processAgentQueueMessage` on Workers and the Node `agent` queue, typed in `env.d.ts`, named in `worker-utils.ts` and covered by `tests/queue-log-context.test.mjs`. SQLite triggers behave the same on D1 and better-sqlite3. On Node a compatible provider (with the opt-in) is needed for one-line summaries.
- **Backups.** `ai_summaries` goes into `BACKUP_TABLES` after `agent_suggestions` (it references `messages`, `mailboxes` and `users`), the `assistant` group and `DatabaseBackupTable`; not in `REQUIRED_BACKUP_TABLES`. It is kept rather than skipped as derived, because one-line summaries are made only for new mail and could not be regenerated after a restore; the coverage digest makes a restored summary correctly current or out of date. A restore inserts messages before summaries (foreign-key order), and the triggers do not fire on insert. Tests: restore a pre-0070 backup after 0070, and a round trip.

## 13. Rollout and flags

- No new install-wide flag: the button follows the assistant switch; one-line summaries follow the automatic-reading install switch, its external-provider opt-in and caps, and are off per mailbox until someone turns them on.
- The CHANGELOG names migration 0070 and links the assistant settings with an app path (`docs/releasing.md`).
- Feature A can ship before AI writing; without `summary_instructions` the prompt omits that heading.

## 14. Tests

### 14.1 Unit

- `summary-eligibility.test.mjs`: statuses, verdicts, Screener, drafts; the 20-message window and the 24,000-character budget; quoted text removed.
- `summary-digest.test.mjs`: the digest changes on a new, moved or deleted message and not on a read or star change.
- `summary-output.test.mjs`: plain text, Markdown stripped, limits, unknown links dropped, meta replies refused, labels limited to the four.
- `line-summary-gate.test.mjs`: every rule in 5.2, including the daily limit and the newsletter switch.
- `triage-line-extension.test.mjs`: with the setting off, `buildTriagePrompt` and `buildTriageJsonSchema` equal today's fixtures; with it on, `oneLine` is present, the output cap is 60 higher, and a bad `oneLine` never fails the parse.
- A `SqliteDatabase` test for the 7.2 triggers: delete and trash remove `thread` rows of that conversation only.
- Backup tests for `ai_summaries`; `tests/queue-log-context.test.mjs` for the queue message `{ kind: "agent.line_summary", jobId }`.

### 14.2 e2e with the fake model (`e2e/55-thread-summaries.spec.ts`; take the next free number)

New fake scenarios: `summary-thread`, `summary-hostile` (Markdown, an unknown link, "Here is"), and a `oneLine` field in the triage scenarios.

1. Deliver a three-message conversation; **Summarize** shows the overview and points; reopening shows it with no new fake-model request.
2. Deliver a fourth message; the card says "New messages since this summary"; **Summarize again** makes one request.
3. A message in Spam and a screened message show no button; the route answers `not_eligible`.
4. A read-only user of a shared mailbox sees the cached summary.
5. `summary-hostile`: no Markdown, no unknown link.
6. Mailbox with automatic reading at Suggest and one-line summaries on: the line appears in the list without a reload, and the fake model recorded **one** request for that message (the triage request, carrying `oneLine`).
7. Autonomy off and one-line summaries on: one `line_summary` request; a newsletter (`List-Id`) gets none until **Include newsletters** is on; daily limit 1 stops the second.
8. Move a summarised conversation's message to Trash: the conversation summary is gone.
9. The card in Kite, Classic and dark mode.

## 15. Sizing

Work on `mission/thread-summaries`; the same validation as every Mission (`npm run check:mission`).

| Feature | Work | Acceptance | Size |
| --- | --- | --- | --- |
| **A. Summarize button** | Migration 0070, `ai_summaries`, triggers, summary utils, `GET`/`POST /api/messages/[id]/summary`, reader card and toolbar button, the triage-summary rule of 4.4, `get_thread.summary`, backups, docs, e2e 1–5, 8, 9 | Section 4 behaviour, cache shared and invalidated, nothing excluded reaches the model | 3–4 days |
| **B. One-line summaries** | Settings and columns, `lineSummaryGate`, the triage core extension, the `line_summary` job, list field, realtime event, appearance preference, Screener release hook, e2e 6–7 | One model call per message at most; gates and caps apply | 3 days |

## 16. Place in the roadmap

- **After** [AI writing](ai-writing.md) (shared untrusted-block helper, `summary_instructions`, `selectInteractiveModel`). Feature A can go first if needed, with those pieces built here instead.
- **Before** [semantic search](semantic-search.md) and [assistant by email](assistant-by-email.md); the assistant by email can answer "summarise my unread mail" by reading cached summaries.
- **Interacts with** milestone 20 (unified mailbox): one-line summaries are per mailbox, so the combined view shows them per row as is. The "more chat actions" work being built now does not touch summaries.

## 17. Open questions for Michiel

1. Language of summaries: the conversation's language (as specified) or the reader's interface language?
2. May read-only users of a shared mailbox trigger a summary (and spend), or only users with send rights and above?
3. Should **Include newsletters** be on by default? Newsletters are where list summaries help most and where most of the cost would go.
4. Retire the triage `summary` suggestion kind once the button exists, or keep both as specified in 4.4?
5. Keep summaries in backups (as specified), or skip them as derived data?
