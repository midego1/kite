# Spec: automatic mail reading agent ("Kite reads for you")

Status: approved for a Factory Mission; first in order, before [storing attachments once](attachments-once.md) and [Drive and storage](drive-storage.md). Written against `main` at `22b1ac3`; take the next free migration number when you start. Scope: Roadmap Milestone 5 (Agents). Item 5.2, the agent audit log, is delivered here as `agent_actions`. Item 5.1 (email-addressable agents) can reuse the same pipeline later.

## 1. Summary

An optional, per-mailbox setting that has Kite read every incoming message once, after delivery, and prepare suggestions such as these:

- "This invite conflicts with *Team sync*. Decline, or propose Tue 14:00?"
- "Reply drafted."
- "Invoice due 3 Nov, filed under Receipts."
- "This looks like phishing."

The default is **Suggest only**. Higher levels may take reversible actions with undo, and, for senders and rules the user has approved, send narrowly scoped replies.

Design principles:

1. **The model proposes and code decides.** The automatic path never gives the model mailbox tools. The model returns a validated JSON triage result. Deterministic code turns that result into suggestions and runs any action allowed by the mailbox autonomy level.
2. **Recipients, times and targets come from data, not from the model.** Reply recipients come from `getReplyRecipients`. Proposed meeting times come from the free/busy computation. Folders come from the user's existing folders.
3. **Run deterministic checks first and use the LLM only when it adds something.** Calendar invites, `List-Unsubscribe`, spam signals and bulk headers are detected without a model call.
4. **Everything is audited, and everything reversible can be undone.**

Non-goals for this milestone: two-way calendar sync, fetching links, forwarding, attachment OCR, and training or fine-tuning.

## 2. What exists today

| Area | Where | Relevance |
| --- | --- | --- |
| Provider and model | `src/lib/agent/provider.ts`, `model.ts`, `provider-constants.ts` (`DEFAULT_CLOUDFLARE_MODEL = "@cf/moonshotai/kimi-k2.5"`), `provider-models.ts` (`CLOUDFLARE_TOOL_MODELS`: Kimi K2.5, Llama 3.3 70B, Qwen3 30B; the catalog fetch returns per-model rates) | Workers AI (`env.AI`) or an OpenAI-compatible provider (OpenAI, OpenRouter, Groq or custom HTTPS). The config is in `app_settings.agent_*`, and the key is sealed with `openSetting`. |
| Global switch | `app_settings.agent_enabled`, `getAgentEnabled()`, `PUT /api/admin/agent` (`src/app/api/admin/agent/route.ts`) | This becomes the master kill switch. |
| Chat assistant | `src/lib/agent/chat.ts` (`streamText`, `stepCountIs(maxSteps)`), `step-limit-utils.ts` (Max steps 3–30, default 15, `users.agent_max_steps`, migration 0058) | Interactive only. The new pipeline does not use this tool loop. |
| Email tools | `src/lib/agent/tools.ts` (`list_emails`, `get_email`, `get_thread`, `search_emails`, `count_emails`, `draft_email`, `draft_reply`, `edit_draft`, `review_draft_send`, `mark_email_read`, `move_email(s)`, `discard_draft`); `AgentToolContext.origin: "chat" \| "auto" \| "mcp"` | With `origin: "chat"`, organise actions return `pending_approval`. With `"auto"` they run immediately. `review_draft_send` refuses any origin other than `chat`. |
| Approvals | `src/lib/agent/approvals/utils.ts` (`requestAgentSend` hashes a draft snapshot), `agent_send_approvals`, `src/lib/agent/actions.ts` (`confirmAgentAction`), `/agent/review/[id]` | Reuse for click-to-send of agent drafts. |
| **Auto-draft (already shipped)** | `src/lib/agent/jobs/utils.ts`: `scheduleAutoDraft` (skips non-`received`, filed, spam, own addresses, out-of-office, and automatic mail via `isAutomaticMessage`) and `processAgentDraftJob` (lease, one running job per mailbox, daily limit, supersede checks, 3 attempts with backoff); `mailbox_agent_settings` (`enabled`, `model_id`, `auto_draft_enabled`, `reviewer_user_id`, `instructions`, `daily_limit`); `agent_jobs`; `agent_draft_metadata` | This is the starting point. The new triage job generalises it, and auto-draft becomes the `reply_draft` capability. |
| Queue | `kite-agent` → `AGENT_QUEUE` (`wrangler.jsonc`); `{ kind: "agent.draft", jobId }` is dispatched in `worker.ts` `queue()` and in `server/index.ts` `runtime.agentQueue.setConsumer`; log names come from `worker-utils.ts`; the type is in `env.d.ts`; `runAgentMaintenance` runs on every cron and in `server/runtime/scheduler.ts` | Add `agent.triage`. Recovery reuses the maintenance hook. |
| Hook point | `src/lib/email/inbound.ts`: `scheduleAutoDraft` is called at the end of `processInboundMessage` (after the insert, auto-reply, realtime and webhooks), and again in the duplicate-raw-key recovery branch (less than 30 minutes old) | Replace both calls with `scheduleAgentWork`. Every intake path (Email Routing, SMTP, relay, Resend, SES) reaches this function through `INBOUND_QUEUE` (`src/lib/email/intake.ts`). |
| MCP | `src/lib/mcp/server.ts` (scopes `mcp:read`, `mcp:draft`, `mcp:organize`, `mcp:request-send`, `mcp:calendar-read`, `mcp:calendar-write`), `mcp_key_mailboxes` | No change in the first slice. Later, read-only `list_suggestions` under `mcp:read`. MCP must never change autonomy settings. |
| Calendar | `calendar_events` (per user; no external UID, organizer or RSVP fields); `src/lib/calendar/tools.ts` (`get_schedule`, `find_free_time`, which builds busy blocks from `expandToolEvents`); `src/lib/calendar/utils.ts` `createCalendarInvitation` (outbound METHOD REQUEST/CANCEL with the `@mailflare` UID suffix) | **There is no inbound ICS parsing and no RSVP REPLY yet.** Both are new. |
| Booking | `booking_events` (working hours: `weekdays`, `time_ranges`, `time_zone`), `src/lib/booking/availability.ts` `availableBookingSlots` | Source of working hours for proposed times. |
| Spam and phishing signals | `src/lib/spam/engine.ts` (`inbox`/`suspicious`/`spam`), `analyzers/authentication.ts` (`spf/dkim/dmarc_passed/failed`), `analyzers/urls.ts` (`displayed_link_mismatch`, `ip_address_url`, `punycode_url`); stored in `messages.spam_signals` | A free, deterministic phishing input. It also tells us whether the sender passed authentication. |
| Unsubscribe | `src/lib/email/unsubscribe.ts` (`getUnsubscribeUrlFromRawR2Key` reads `List-Unsubscribe` from the raw MIME) | Newsletter suggestions without a model call. |
| Organising | `updateMessageStatusForUser` (`src/lib/user.ts`), `folders`, `messages.snoozed_until`, mailbox-scope `routing_rules` (`resolveInboxRuleDestination`) | Targets for label, archive and remind actions. |
| Sending | `sendEmail` (`src/lib/email/send.ts`, supports `scheduledAt` → `outbound_jobs`), `/api/send/undo` | A full-auto send becomes a scheduled send with a hold window, so it can be undone. |
| Permissions | `src/lib/mailboxes/access.ts`: `read_only < send_on_behalf < send_as < full_access` → `canRead`, `canSendOnBehalf`, `canManage`; mailbox `type: personal \| shared` | The acting identity is the reviewer user, as in auto-draft. |
| Realtime | `notifyUsersOfNewMessage` (`src/lib/realtime/utils.ts`), `AgentDraftNotification` (`src/lib/realtime/types.d.ts`), handled in `src/hooks/use-message-polling.ts` | Add an `agent_suggestion` event. |
| Usage and cost | `ai_usage` (provider, model, source, tokens, `cost_usd_micros`), `recordAiUsage`, `calculateAgentCostUsdMicros`, the `/ai-usage` page | Add mailbox attribution so per-mailbox and install-wide spend caps can be enforced. |
| Rate limit | `AGENT_RATE_LIMIT` (120/60s), `allowAgentRequest` | Reuse as a burst guard per mailbox. |
| Settings UI | `src/components/agent/agent-panel.tsx` (auto-draft toggle at about line 890, daily limit at about line 909, privacy note at about line 926) | Extend with an "Automatic reading" section. |
| Node runtime | `server/runtime/env.ts` (`openKiteQueue("agent", sqlite)`); no `env.AI`, so the provider must be `compatible`; `server/runtime/scheduler.ts` | Same code path, nothing Workers-specific. |
| e2e | Browser-level mocks only (`e2e/14-assistant-design.spec.ts` `page.route`). **There is no server-side fake model.** The loopback HTTP receiver precedent is `ALERT_WEBHOOK_ALLOW_INSECURE` (`vite.config.ts` customizer, serve only, plus `isAlertWebhookInsecureAllowed`) | Add a loopback fake OpenAI-compatible server (see §11.2). |

## 3. Autonomy levels (per mailbox)

These are stored on `mailbox_agent_settings.autonomy`. Changing them requires `canManage` on the mailbox. **Full auto** also requires the install-wide `app_settings.agent_full_auto_allowed`, which only the primary admin can set.

| Level | May do | Never does |
| --- | --- | --- |
| **Off** | No automatic reading, so no triage jobs and no triage model calls. Existing chat still works. A mailbox that still has the legacy `auto_draft_enabled` toggle on keeps today's auto-draft job, which makes one draft model call per eligible message (§5.1). | Create suggestions or take actions. |
| **Suggest only** (the default when the feature is turned on) | Create `agent_suggestions`. Create inert agent drafts (as today's auto-draft does, marked `origin: "auto"`). Show warnings. Every action runs only on a user click. | Change message state, write to the calendar, send. |
| **Act with undo** | Everything in Suggest. Also, automatically: apply a folder or label, archive, mark read, set a reminder (`snoozed_until`), and place a calendar hold for invites with no conflict. Each action is written to `agent_actions` with its inverse and an undo window (default 7 days). | Send, trash, mark spam, delete, write outside the mailbox or reviewer calendar. |
| **Full auto (approved senders and rules)** | Everything in Act with undo. Also, **only** for senders that match `agent_sender_policies`, pass SPF/DKIM/DMARC alignment and have the action enabled in their policy: send an RSVP (accept when free, decline when busy if the policy allows it) and send a reply drafted under an approved template rule. Sends go through `sendEmail` with `scheduledAt = now + holdMinutes` (default 10), so they are visible and undoable in Sent/Scheduled. | Send to any address that is not the original sender or organizer. Send more than 1 automatic message per thread per 24 hours, or more than the daily cap. Forward. Run when the message is `suspicious`. |

Global rules for every level:

- A suspicious or spam verdict, a failed authentication check or a phishing suggestion forces that message down to Suggest.
- `paused_until` on the mailbox and `agent_auto_read_enabled` in the app act as kill switches.
- The reviewer must still hold the permission an action needs when it runs. That means `canSendOnBehalf` for drafts and sends, and `canManage` for moves, which matches `requireAccess(context, false, true)` in `tools.ts`.

## 4. Capability catalogue

A **D** marks a capability that needs no model call. Each capability can be toggled in `mailbox_agent_settings.capabilities`.

| Capability | Detection | Suggest | Act with undo | Full auto | Slice |
| --- | --- | --- | --- | --- | --- |
| Calendar invites | D: a `text/calendar` attachment or `.ics` with `METHOD:REQUEST`/`CANCEL` | Card: event details, conflicts, buttons Accept / Decline / Propose new time | Tentative hold on the reviewer calendar | Send RSVP to an allowlisted organizer | **1** |
| Reply drafts | LLM triage `needsReply` (replaces the "always draft" behaviour of auto-draft when the level is above Off) | Agent draft plus a "Review and send" button | same | Send under an approved template rule | **1** (reuses `processAgentDraftJob` generation) |
| Thread summary | LLM triage `summary` (only for threads of 3 or more messages, or bodies over 1,500 characters) | Shown in the reader card | — | — | **1** |
| Phishing warning | D: `spam_verdict = suspicious`, `displayed_link_mismatch`, auth failures, display-name spoofing of a known contact; LLM `suspicious.reasons` adds to these but never clears them | Red banner in the reader with the reasons | Suggest only | Suggest only | **1** |
| Tasks and deadlines | LLM `tasks[]` with `dueAt` validated as a future date within 1 year | "Remind me on 3 Nov" | Set `snoozed_until` to the day before the due date | same | 2 |
| Receipts and invoices | D: subject, sender and attachment heuristics, then confirmed by the LLM `category` | "File under Receipts" | Move to the configured folder | same | 2 |
| Labelling and archiving | LLM `category` mapped to user-configured folder rules; never invents folders | "Move to Newsletters" | Apply | same | 2 |
| Newsletter unsubscribe | D: `List-Id` plus `List-Unsubscribe`, and the user has not opened the last N messages from this list | "Unsubscribe?" | Suggest only | Suggest only (the one-click POST runs only when the user clicks) | 3 |
| Follow-up nudges | D, cron: an outbound `sent` message with no inbound reply in its thread after N days | "No reply from X in 4 days. Draft a nudge?" | Draft only | — | 3 |

**First slice (milestone A–E below):** the framework, Suggest only, calendar invites, reply drafts, summaries and phishing warnings. These cover what the user asked for (invite → availability → accept or reschedule draft) and exercise every part of the pipeline: deterministic detection, LLM triage, an LLM draft, a calendar read, a one-click send, and audit with undo.

## 5. Architecture

### 5.1 Flow

```
processInboundMessage (src/lib/email/inbound.ts)
  └─ scheduleAgentWork(env, {...same input as scheduleAutoDraft})     src/lib/agent/auto-read/schedule.ts
       gates: agent_enabled && agent_auto_read_enabled && autonomy != off && !paused
              status=received, not spam/trash, not own address, not mailer-daemon/auto-submitted,
              message < 30 min old (recovery path)
       insert agent_jobs {kind:"triage"} ON CONFLICT DO NOTHING → AGENT_QUEUE.send({kind:"agent.triage", jobId})
       (autonomy=off && auto_draft_enabled keeps today's {kind:"draft"} job for compatibility)

worker.ts queue() / server/index.ts agentQueue consumer
  └─ processAgentTriageJob(env, jobId)                                 src/lib/agent/auto-read/process.ts
       1 claim lease (same SQL as processAgentDraftJob: one running job per mailbox)
       2 re-check gates, reviewer access, count caps, supersede (newer message in thread)
       3 facts = collectFacts(message)       D: ics, list headers, spam signals, auth, bulk, contact known   (pure: facts-utils.ts)
       4 if needsModel(facts, capabilities): reserveAiSpend(...) (§7, item 8; no row → skip with reason),
            then triage = runTriageModel(...)  generateText → zod TriageResult   (triage.ts)
       5 plan = planSuggestions(facts, triage, settings, policies)    pure, policy-utils.ts
       6 for each planned item: upsert agent_suggestions (unique message_id+kind)
            capability extras: calendar → availability (code); reply → reserveAiSpend, then draft via existing generation + draft_reply
       7 for items the level allows to run automatically: executeAction() → agent_actions row (pending) first, then apply
       8 notifyUsersOfNewMessage(reviewer + mailbox users, {type:"agent_suggestion", ...})
       9 job completed; each reservation was reconciled with actual usage (mailboxId/jobId) right after its call
```

### 5.2 Modules (new files unless stated)

- `src/lib/agent/auto-read/schedule.ts`: `scheduleAgentWork`. Moves `isAutomaticMessage` out of `jobs/utils.ts` into `auto-read/facts-utils.ts` and exports it.
- `src/lib/agent/auto-read/facts-utils.ts` (pure): `collectFacts({ headers, spamSignals, spamVerdict, attachments, fromAddr, knownContact })` → `{ bulk, listUnsubscribe, invite?, auth: { spf, dkim, dmarc }, suspicious, phishingSignals[] }`.
- `src/lib/agent/auto-read/triage-types.d.ts` and `triage-utils.ts` (pure): the `TriageResult` zod schema, `buildTriagePrompt` (spotlighting, see §7, item 5), and `parseTriageOutput` (strict JSON, one repair attempt, otherwise the job fails).
  - `TriageResult = { category: "needs_reply"|"fyi"|"calendar"|"receipt"|"newsletter"|"notification"|"other", needsReply: boolean, urgency: "none"|"low"|"high", summary: string ≤ 280, tasks: {title ≤ 120, dueAt?: ISO}[] ≤ 5, suspicious: { flagged: boolean, reasons: ("credential_request"|"payment_change"|"urgency_pressure"|"spoofed_identity"|"unexpected_attachment")[] } }`
  - The schema has no free-form instruction, address or URL fields.
- `src/lib/agent/auto-read/policy-utils.ts` (pure, the core of the security model): `planSuggestions` and `allowedToExecute(level, action, facts, senderPolicy)`. It contains the complete matrix from §3. Unit tested exhaustively.
- `src/lib/agent/auto-read/execute.ts`: `executeAction` and `undoAgentAction`. Every action type has an `apply(before) → after` and an `inverse(after)`. All actions call existing functions (`updateMessageStatusForUser`, `runCalendarTool` with `create_event`/`delete_events`, `sendEmail`) with the reviewer as `user`.
- `src/lib/calendar/ics-parse-utils.ts` (pure): unfold lines; parse `METHOD`, the first `VEVENT` `UID`/`SEQUENCE`/`DTSTART`/`DTEND`/`DURATION`/`TZID`/`SUMMARY`/`LOCATION`/`ORGANIZER`/`ATTENDEE;PARTSTAT`/`RRULE` (RRULE kept raw and shown as "repeats"; only the first occurrence is checked); cap input at 256 KB; reject unknown TZIDs instead of guessing.
- `src/lib/calendar/availability-utils.ts` (pure): `busyBlocks(events, from, to)` extracted from `runCalendarTool` `find_free_time` (which then calls it), `findConflicts`, and `proposeSlots(busy, durationMin, workHours, tz, count=3, horizonDays=7)`. Working hours come from the reviewer's first enabled `booking_events`, otherwise Mon–Fri 09:00–17:00 in `users.time_zone`.
- `src/lib/calendar/utils.ts`: add `createCalendarReply({ uid, sequence, organizer, attendee, partstat, start, end, summary })` → `METHOD:REPLY`. It keeps the organizer's UID exactly; the `@mailflare` suffix applies only to Kite-originated UIDs.
- Queue: `{ kind: "agent.triage"; jobId }` is added to `env.d.ts` `AGENT_QUEUE`, `worker.ts` `queue()`, `server/index.ts`, `worker-utils.ts` (`"agent.triage": "agent_triage"`), and `tests/queue-log-context.test.mjs`.
- Maintenance: `runAgentMaintenance` also recovers triage jobs (generalise `recoverAgentDraftJobs` by `kind`), expires suggestions after 14 days, and prunes `agent_actions` older than 180 days in `src/lib/maintenance/pruning.ts`.

### 5.3 Calendar invite behaviour

1. Facts: `messageAttachments` rows with a `text/calendar` type or the `.ics` extension are read from R2 by `r2Key`, then `parseIcsInvite` runs.
2. Code computes availability: `get_schedule` over [start − 30 min, end + 30 min] → `findConflicts`. If there are conflicts, `proposeSlots` runs.
3. The suggestion payload is `{ uid, sequence, method, organizer, start, end, tz, summary, conflicts: [{eventId, title, start, end}], proposals: [{start,end}], organizerMatchesSender, authPassed }`.
4. Actions:
   - **Accept**: insert a `calendar_events` row (new columns `ical_uid`, `ical_sequence`, `organizer`, `source_message_id`), then send a `createCalendarReply(ACCEPTED)` attached to a short email to the organizer through `sendEmail`. The sender is the mailbox address and the recipient is the organizer only.
   - **Decline**: send the REPLY with DECLINED, with no event created.
   - **Propose new time**: the LLM writes a short prose draft through the existing auto-draft generation path. The code inserts the 2–3 computed slots as a fixed, formatted list, then saves the draft with `draft_reply`. The user sends it from the composer. The model never chooses times.
   - **Update** (same UID, higher SEQUENCE): suggest "Update event". **CANCEL**: suggest "Remove from calendar".
5. Undo:
   - Accept: delete the event. If the RSVP is still within its hold window, cancel it through `/api/send/undo`. Otherwise offer "Send decline instead".
   - Decline: offer "Accept instead".
6. Calendars are personal (`calendar_events.user_id`). On **shared** mailboxes, the calendar capability is off by default and acts only on the reviewer's calendar when enabled.

## 6. Data model

One hand-written migration `drizzle/migrations/0060_add_agent_auto_read.sql` plus a journal entry. Schema changes go in `src/db/schema/index.ts`.

**Altered tables**

- `mailbox_agent_settings`:
  - `autonomy` text `off|suggest|act|auto`, default `off`.
  - `capabilities` text JSON, default `'{"calendar":true,"reply":true,"summary":true,"phishing":true}'`.
  - `triage_model_id` text, nullable (null means the cheapest configured model, see §8).
  - `auto_read_daily_limit` int, default 200.
  - `daily_spend_cap_micros` int, nullable.
  - `paused_until` timestamp.
  - `full_auto_hold_minutes` int, default 10.
  - Backfill: `UPDATE mailbox_agent_settings SET autonomy='suggest' WHERE auto_draft_enabled=1`.
- `app_settings`:
  - `agent_auto_read_enabled` boolean, default 1. This is the install kill switch.
  - `agent_full_auto_allowed` boolean, default 0.
  - `agent_daily_spend_cap_micros` int, default 2_000_000 ($2/day).
  - `agent_external_auto_read_allowed` boolean, default 0 (see §7, item 12).
- `agent_jobs`:
  - `kind` text `draft|triage`, default `draft`.
  - Replace the unique index `agent_jobs_source_idx` with `(mailbox_id, source_message_id, kind)`. Use DROP INDEX then CREATE UNIQUE INDEX, since SQLite allows this without rebuilding the table.
- `ai_usage`: `mailbox_id` (FK `mailboxes`, ON DELETE SET NULL) and `job_id` text, both nullable, plus an index `(mailbox_id, created_at)`. `recordAiUsage` takes optional `mailboxId`/`jobId`. Also `reserved` boolean, default 0: 1 while the row holds a spend reservation that has not been reconciled yet (§7, item 8).
- `calendar_events`: `ical_uid`, `ical_sequence` int, `organizer`, `source_message_id` (FK `messages`, SET NULL), all nullable, plus an index `(user_id, ical_uid)`.

**New tables**

- `agent_suggestions`:
  - Columns: `id`; `mailbox_id` (FK cascade); `message_id` (FK `messages` cascade); `thread_id`; `job_id` (FK `agent_jobs` SET NULL); `reviewer_user_id` (FK `users` cascade); `kind` (`calendar_invite|reply|summary|phishing|task|receipt|label|unsubscribe|follow_up`); `status` (`open|accepted|dismissed|expired|superseded|auto_applied`); `title` (code-generated from a template, max 200); `payload` (JSON, validated by a per-kind zod schema in `src/lib/agent/auto-read/suggestion-types.d.ts`); `draft_id` (FK `messages` SET NULL); `confidence` int; `model`; `created_at`; `decided_at`; `decided_by_user_id` (FK SET NULL); `expires_at`.
  - Indexes: unique `(message_id, kind)`, `(mailbox_id, status, created_at)`.
- `agent_actions` (the audit log; Roadmap 5.2):
  - Columns: `id`; `mailbox_id` (FK cascade); `suggestion_id` (FK SET NULL); `message_id` (FK SET NULL); `job_id`; `initiator` (`agent|user`); `acting_user_id` (FK SET NULL; whose permission was used); `autonomy`; `action` (`create_draft|move|mark_read|set_folder|remind|create_event|delete_event|send_rsvp|send_reply|unsubscribe|dismiss`); `variant` text, default `''` (the outcome for actions that have more than one, for example the PARTSTAT `accepted|declined` of `send_rsvp`); `status` (`pending|applied|undone|failed|blocked`); `before` JSON; `after` JSON; `reason` (the policy rule ID that allowed or blocked it); `undo_until`; `undone_at`; `undone_by_user_id`; `created_at`; `updated_at`.
  - Indexes: `(mailbox_id, created_at)`, and a partial unique index `(suggestion_id, action, variant) WHERE status IN ('pending','applied')`. The unique index makes execution idempotent. Because it covers only live rows, Accept and Decline on the same invite are distinct keys, and an outcome can be applied again after its earlier action was undone or failed. A later REPLY replaces an earlier one, so sending the opposite RSVP sets the earlier `send_rsvp` row to `undone`; that is what lets Accept, then "Send decline instead", then "Accept instead" each run once.
  - Execution: the executor inserts the row as `pending` (with any id the side effect will use, see §9) before the side effect, then sets `applied` or `failed`. If the insert conflicts with an `applied` row, the action is skipped. If it conflicts with a `pending` row whose `updated_at` is older than the 10-minute job lease, the crash left it unfinished: the executor takes the row over and resumes it. Resuming first checks whether the side effect already happened (the state already equals `after`, the event or the queued message already exists) and only applies what is missing. A fresh `pending` row belongs to a run in progress, so a user click on it gets 409.
  - Blocked attempts are recorded too, for example when the model proposed something the policy refused.
- `agent_sender_policies`:
  - Columns: `id`; `mailbox_id` (FK cascade); `pattern` (`addr@x` or `@domain`, normalised); `require_auth` boolean, default 1; `allowed_actions` JSON (`["send_rsvp","send_reply","move"]`); `template_rule` text, nullable (the approved reply template text for `send_reply`); `created_by_user_id`; `created_at`.
  - Index: unique `(mailbox_id, pattern)`.

**Backup lists (required by AGENTS.md, in the same change)**

- `src/lib/backups/export.ts` `BACKUP_TABLES`: insert `agent_suggestions`, `agent_actions` and `agent_sender_policies` after `agent_send_approvals` (FK order: after `messages`, `agent_jobs` and `users`; `agent_actions` after `agent_suggestions`). They are **not** added to `REQUIRED_BACKUP_TABLES`, so older documents still restore.
- `src/lib/backups/table-groups.ts`: add the three tables to the `assistant` group.
- `src/lib/backups/types.d.ts`: add them to the `DatabaseBackupTable` union.
- The new columns need no list change. Test restoring a backup taken before 0060 into a database after 0060, and a backup taken after 0060 into a fresh database (see feature A in §12).

## 7. Security

**Threat model.** The attacker controls the content of incoming mail: body, subject, display name, attachments (including ICS text fields) and headers that are not authenticated. The goals are to exfiltrate mail, send as the user, change calendar or state, spam other people, run up spend, or hide mail.

1. **No tools on the automatic path.** Triage and drafting call `generateText` with **no `tools`**. The triage output is a closed zod schema with no address, URL or free-text instruction fields. The draft output is only a body. Prompt injection can therefore at most produce wrong suggestion content or a misleading draft body. It cannot cause an action the policy does not allow.
2. **Code-bound parameters.** Recipients come from `getReplyRecipients` (which already refuses own addresses) or the ICS `ORGANIZER`. When `organizerMatchesSender` is false or authentication fails, the card shows a warning and Full auto is disabled. Times come from `proposeSlots`, and folders from existing `folders` rows. `edit_draft` and `draft_email` are not reachable from the automatic path. No forwarding exists at all, and no address that is new to the thread is ever used.
3. **Sending requires a click by default.** In Suggest and Act with undo, a send happens only from a user click: the card's Accept or Decline button, or the composer's Send. Full auto sends only under §3 conditions (allowlisted, authenticated, not suspicious, at most 1 per thread per 24 hours, under the daily cap, held for `full_auto_hold_minutes` and undoable). `allowedToExecute` is the single gate. The executor also re-checks it right before the side effect, inside the same function.
4. **No link fetching or remote content.** The pipeline never calls `fetch` with a URL taken from mail. Unsubscribe uses only the `List-Unsubscribe` header, and only on click (RFC 8058 one-click POST, or opening a `mailto:` draft). Remote images and attachments other than the ICS are not read. URLs in the model input are kept as text but marked as untrusted.
5. **Untrusted-data prompting (spotlighting).** Email content goes into the user turn, wrapped as `<<<EMAIL id=… nonce=RANDOM>>> … <<<END nonce>>>`. Any nonce-like sequence in the content is stripped. The system prompt, a constant in `triage-utils.ts`, says the content is data and that the only valid output is the JSON schema. Mailbox `instructions` stay limited to 4,000 characters and are placed in the system prompt as preferences that cannot override the rules, as in `agentSystemPrompt`.
6. **Output checks.** After the model returns, the code:
   - rejects drafts that contain addresses or URLs that do not appear in the thread;
   - rejects drafts that start with meta text (the existing `/^(here is|i have drafted…)/` check);
   - caps lengths;
   - strips Markdown;
   - drops any task `dueAt` that is in the past or more than 1 year away.

   A phishing flag from the model can only add warnings. It can never clear a deterministic warning.
7. **Sender trust.** Sender policies match the normalised `From` and require `dkim_passed` or `dmarc_passed` in `spam_signals` when `require_auth` is set. Display-name spoofing of an allowlisted contact (same name, different address) forces Suggest and adds a phishing suggestion.
8. **Caps and spend.**
   - Per mailbox: `auto_read_daily_limit` triage jobs per day; existing `daily_limit` drafts per day; `daily_spend_cap_micros`.
   - Install-wide: `agent_daily_spend_cap_micros`, summed from `ai_usage.cost_usd_micros` since 00:00 UTC.
   - When rates are unknown, a token cap of 2M input tokens per day stands in for the spend cap.
   - **Atomic reservation.** The per-mailbox lease does not stop jobs in different mailboxes from passing a check against recorded usage at the same time. So before **each** model call (triage and draft), `reserveAiSpend` inserts the `ai_usage` row up front with `reserved = 1`, the estimated input tokens (prompt characters / 4), `maxOutputTokens` as the output tokens and the cost at the model's rates, in one conditional statement:

     ```sql
     INSERT INTO ai_usage (...) SELECT ... WHERE
       (SELECT coalesce(sum(cost_usd_micros),0) FROM ai_usage WHERE created_at >= ?dayStart) + ?estimate <= ?installCap
       AND (?mailboxCap IS NULL OR (SELECT coalesce(sum(cost_usd_micros),0) FROM ai_usage
            WHERE mailbox_id = ?mailboxId AND created_at >= ?dayStart) + ?estimate <= ?mailboxCap)
     ```

     When rates are unknown, the same statement compares `sum(input_tokens)` with the token cap instead. Zero rows changed means the cap is reached and the job is skipped without calling the model. After the call, the same row is updated with the actual tokens and cost and `reserved = 0`; a failed call sets the cost to what was billed (0 when nothing was). A row left reserved by a crash keeps its estimate, so the cap errs on the side of stopping. Chat and other callers keep using `recordAiUsage`, and their recorded rows count towards the same sums.
   - `AGENT_RATE_LIMIT` limits bursts per mailbox.
   - When a cap is hit, the job is skipped with a reason, and the Activity view shows "Paused: daily limit reached".
9. **Kill switches.** Global: `agent_enabled` stops everything, and `agent_auto_read_enabled` stops only automatic reading. Per mailbox: `autonomy=off` (the legacy auto-draft toggle is separate, §3) or `paused_until`, and the "Pause for 24 hours" button in the card menu. Full auto turns itself off (`autonomy → act` plus an audit row) when more than 3 automatic sends are undone within 7 days, or when more than 20 actions run in 1 hour.
10. **Audit.** Every applied, blocked or failed action is written to `agent_actions` **before** its side effect, as `pending` (status `applied` is set after success; a failure is recorded as `failed`; a `pending` row left by a crash is resumed, see §6). Mailbox users with full access (`canManage`) can see the log. Undo requires the permission the original action used.
11. **Permissions.** The acting identity is `reviewer_user_id`, re-validated on each job, as `processAgentDraftJob` does. Suggestions are visible only to users with full access (`canManage`) on the mailbox, and only they can accept them. Agent drafts belong to the reviewer (`messages.user_id`), as today.
12. **Privacy.** Workers AI keeps content on Cloudflare's network, and Cloudflare says it does not train on customer inputs; link the current Workers AI privacy page in the docs. An OpenAI-compatible provider receives **every incoming email** in auto mode, which is a much larger exposure than chat. Automatic reading therefore refuses to run with a `compatible` provider unless the primary admin sets `agent_external_auto_read_allowed`. The settings section names the provider ("Message content is sent to OpenRouter"). The Node runtime always uses an external provider, so it needs the same opt-in. Prompts and responses are not stored, except suggestion payloads and drafts. Bodies sent to the model are trimmed: triage gets the latest message up to 8,000 characters plus thread subject lines; drafting gets the existing 24,000-character window.
13. **Testing injection resistance** (see §11.3).

## 8. Cost

Assumptions: about 4 characters per token. Triage input is the system prompt (~700 tokens), facts (~150), the latest body (up to ~2,000) and thread headers (~150), so **about 3,000 input tokens**. Triage output is JSON of about 250 tokens. The draft is the existing path, about 6,000 input and 400 output. Kimi K2.5 can emit reasoning tokens. Those are billed as output and may add 300–1,500 tokens, so treat its output figures as a lower bound and disable reasoning for triage where the provider allows it.

| Model (Workers AI) | Rates per 1M tokens (input/output) | Triage per email | Draft per email |
| --- | --- | --- | --- |
| Kimi K2.5 `@cf/moonshotai/kimi-k2.5` | $0.60 / $3.00 (given) | $0.0018 + $0.00075 ≈ **$0.0026** (up to about $0.007 with reasoning) | $0.0036 + $0.0012 ≈ **$0.005** |
| Small triage model (for example `@cf/qwen/qwen3-30b-a3b-fp8` or an 8B Llama) | roughly $0.05–0.15 / $0.30–0.35, **unverified; read from the catalog** | ≈ **$0.0003–0.0005** | — |

Example: 100 inbound per day, of which 40% need a model call after the deterministic filters drop bulk, spam and notifications, and 15% get drafts.

- Kimi only: 40 × $0.0026 + 15 × $0.005 ≈ **$0.18/day** (about $5.40/month).
- Small triage model plus Kimi drafts: about **$0.09/day**.

Free tier: Workers AI includes 10,000 neurons per day, and beyond that bills $0.011 per 1,000 neurons. The free allowance is worth about $0.11 per day, which covers roughly 40 Kimi triage calls per day, or several times that on a small model. Neuron-per-token ratios differ by model and change, so the UI should show the cost from the per-model rates `listCloudflareAgentModels` already loads into `agent_model_rates` rather than hard-coding them. **All figures are estimates; check them against Cloudflare's pricing page before release.**

Model routing:

- `triage_model_id`: default the cheapest configured model that reliably produces JSON. Fall back to the mailbox `model_id`.
- Drafts use `model_id` (Kimi by default).
- Skip the model entirely when deterministic facts settle the result: bulk or list mail, notifications from `no-reply` senders (deterministic suggestions only), a short invite with no body text, or a known receipt sender.

## 9. Runtime

- **Queue.** Use the existing `kite-agent` queue; there is no new binding and no Cloudflare resource rename. One job per (message, kind). The consumer acks after `processAgentTriageJob` returns, and failures retry inside the job (3 attempts, backoff `min(60s, 5s·2^n)` as today). Queue-level `retry({delaySeconds:10})` covers crashes. Cron recovery picks up `pending` jobs that are due and expired leases.
- **Idempotency.**
  - Unique `agent_jobs (mailbox, source, kind)`.
  - Unique `agent_suggestions (message_id, kind)`, upserted.
  - Partial unique `agent_actions (suggestion_id, action, variant)` over `pending` and `applied` rows. The executor inserts a `pending` row first, skips the action when an `applied` row exists, and resumes a stale `pending` row left by a crash (§6).
  - Sends go through `sendEmail` with an `outbound_jobs` row, and the action row records `outboundJobId`. `sendEmail` gains an optional caller-chosen `messageId`: the executor generates it, stores it in the `pending` row, and passes it in. A resumed send therefore finds the existing `messages` and `outbound_jobs` rows and only marks the action `applied`; the `messages` primary key prevents a second copy.
  - A redelivered inbound message hits the existing duplicate-raw-key branch, which calls `scheduleAgentWork` again (a no-op because of the unique index).
- **Ordering.** Queues do not guarantee order. Correctness rests on three checks:
  1. the per-mailbox single running lease (the existing `NOT EXISTS` clause);
  2. the supersede check (a newer inbound message, or a sent reply, in the thread marks older open `reply` suggestions `superseded`);
  3. ICS `SEQUENCE` comparison (a lower sequence never overwrites a higher one).
- **Skipping.** No job is created for spam, trash, own addresses, `mailer-daemon` or `postmaster`, `Auto-Submitted` other than `no`, or messages older than 30 minutes on recovery. For `List-Id`, `Precedence: bulk` and `no-reply` senders, only deterministic facts are used and no model is called. Messages filed by a mailbox rule (`folderId`) get triage but no reply draft, which keeps today's auto-draft behaviour.
- **Time limits.** One model call for triage and at most one for the draft, with `maxOutputTokens` set to 400 for triage and 900 for drafts. The 10-minute lease covers slow providers.
- **Both runtimes.** Only `getEnv()`, `getDb`, `env.BUCKET`, `env.AGENT_QUEUE` and `getAgentModel` are used. On Node, `AGENT_QUEUE` is the SQLite-backed `openKiteQueue("agent")` and the consumer is registered in `server/index.ts`. There is no `env.AI`, so a `compatible` provider is required, which in turn needs the privacy opt-in from §7, item 12. `npm run build:node` must pass, and no React hooks may sit in modules imported by Server Components.

## 10. UI

Use the `blue-*` palette only (it is remapped for Kite and Classic), and check every surface in Kite, Classic and dark mode. Text says "Kite".

- **Inbox row badge** (`src/components/messages/message-folder-page.tsx` row rendering): one icon chip for the highest-priority open suggestion (phishing > calendar > reply > task > receipt), plus "+n". The data comes from `/api/messages` (`src/app/api/messages/route.ts`), which adds `agentSuggestions: {kind,count}[]` per row in one extra query over the page's message IDs (no N+1). In conversation view (`group=thread`), suggestions aggregate over `threadMessageIds`.
- **Reader card** (above the body in `src/components/messages/conversation-thread.tsx`, as a new `src/components/agent/suggestion-card.tsx` with `-types.d.ts` and `-utils.ts`). It shows the summary, then one block per suggestion:
  - Calendar: date and time in the user's time zone, conflicts, and the buttons **Accept**, **Decline**, **Propose new time** (opens the draft).
  - Reply: **Review draft** (opens `/drafts/[id]`) and **Discard**.
  - Phishing: a red banner, styled consistently with `spam-score-details.tsx`, with the reasons and "Mark as spam".

  A "Why?" disclosure shows the policy reason and the model name. A "⋯" menu offers Dismiss, "Don't suggest this for this sender" and "Pause Kite for this mailbox".
- **"For you" view**: `src/app/(dashboard)/for-you/page.tsx`, linked in the sidebar below Inbox (`src/components/dashboard-nav-utils.ts`) with a count of open suggestions. It groups open suggestions by kind, newest first, and supports bulk Dismiss. It is hidden when every mailbox has `autonomy=off`.
- **Activity (audit)**: a tab in the assistant settings (`agent-panel.tsx`) and `/agent/activity`. It lists `agent_actions` with their initiator, action, target link, reason and **Undo** (enabled while `undo_until` is in the future and `status=applied`). Blocked attempts are shown greyed out.
- **Settings**: an "Automatic reading" section in `agent-panel.tsx`, next to the auto-draft toggle. It contains:
  - an autonomy radio group, where Full auto is disabled with an explanation unless the admin allows it;
  - capability toggles;
  - triage model and daily limits;
  - the sender policies editor;
  - a provider privacy line;
  - Pause.

  In the admin agent settings (`/api/admin/agent`), the primary admin manages the auto-read kill switch, Full auto allowed, external provider allowed and the daily spend cap.
- **Realtime**: `AgentSuggestionNotification {type:"agent_suggestion", mailboxId, messageId, suggestionId, kind}` in `src/lib/realtime/types.d.ts`, handled in `src/hooks/use-message-polling.ts` to refresh the badge, the reader card and the For you count. There is no toast, except for phishing on a message the user currently has open.
- **Flows.**
  - Accept or Decline: a `POST /api/agent/suggestions/[id]/accept {option}`, an optimistic card state, then a toast with **Undo**.
  - Dismiss: marks the suggestion `dismissed` and records a `dismiss` action, so it can be undone.
  - Undo: `POST /api/agent/actions/[id]/undo`.
- **API routes**: all session-authenticated through `requireSessionUser` (never `requireUser`), with mailbox access checked through `getMailboxAccessLevel`.
  - `GET /api/agent/suggestions`
  - `POST /api/agent/suggestions/[id]/accept|dismiss`
  - `GET /api/agent/actions`
  - `POST /api/agent/actions/[id]/undo`
  - `GET|POST|DELETE /api/agent/senders`
  - the existing `PUT /api/agent/settings`, extended

  `e2e/13-security.spec.ts` picks these routes up automatically, and each must answer 401 without a session.

## 11. Testing

### 11.1 Unit (`tests/*.test.mjs`, pure modules, no bindings)

- `agent-auto-read-policy.test.mjs`:
  - the full matrix of level × action × facts (auth pass/fail, suspicious, allowlisted, cap reached, shared mailbox);
  - Full auto never sends to an address that is not the sender or organizer;
  - suspicious mail forces Suggest.
- `agent-triage-parse.test.mjs`: valid JSON, fenced JSON, extra keys stripped, invalid enums rejected, a long summary truncated, past `dueAt` dropped, the repair path, and nonce stripping in `buildTriagePrompt`.
- `agent-auto-read-facts.test.mjs`: `isAutomaticMessage` (moved), list and bulk detection, auth signals parsed from `spam_signals`, display-name spoofing.
- `calendar-ics-parse.test.mjs`: Google, Outlook and Apple fixtures (synthetic) in `tests/fixtures/ics/`; folded lines; TZID; all-day events; DURATION; RRULE kept; CANCEL; oversize rejected; unknown TZID rejected.
- `calendar-availability.test.mjs`: `busyBlocks` parity with the current `find_free_time` output, `findConflicts`, `proposeSlots` within working hours and across DST.
- `calendar-reply.test.mjs`: `createCalendarReply` keeps the foreign UID (no `@mailflare`), PARTSTAT, ATTENDEE and SEQUENCE.
- `agent-draft-guard.test.mjs`: unknown addresses or URLs in a draft are rejected.
- Update `tests/queue-log-context.test.mjs` for `agent.triage`.

### 11.2 e2e with synthetic mail and a fake model

There is no server-side model stub today, so add one:

- `e2e/support/fake-model.ts` starts an `http.createServer` on `127.0.0.1:0`. It implements the OpenAI-compatible `POST /chat/completions` (non-streaming) and `GET /models`. The reply is chosen by a scenario marker found in the request messages (for example `[[scenario:invite-free]]`, which the spec puts in the synthetic mail body) or, failing that, from a per-spec queue. It records every request so specs can assert what was sent, for example that no thread content leaks into the wrong mailbox.
- `src/lib/agent/provider.ts` `resolveAgentBaseUrl` accepts `http://127.0.0.1|localhost` only when `env.AI_ALLOW_INSECURE_LOOPBACK === "1"` and `process.env.NODE_ENV !== "production"`. This mirrors `isAlertWebhookInsecureAllowed`. The flag is injected by the `vite.config.ts` `config()` customizer only for `command === "serve"` (as `ALERT_WEBHOOK_ALLOW_INSECURE` is) and set in `playwright.config.ts` `webServer.env`.
- Specs save the provider as `compatible`/`custom` pointing at the fake server through `PUT /api/admin/agent`, and restore it afterwards, as `07-settings` does with `enabled`. Mail arrives through `deliverInbound` (`e2e/support/helpers.ts`), extended with an optional `attachments` field (for example `invite.ics` as `text/calendar; method=REQUEST`).

New spec `e2e/21-auto-agent.spec.ts`:

1. With the setting off and legacy auto-draft off, no suggestion appears and the fake model receives no request.
2. Suggest mode with an invite at a free time: the card shows "No conflicts". Accept creates a calendar event (checked through `/api/calendar/events`) and a Sent message with `invite.ics` METHOD:REPLY. Undo removes the event.
3. An invite that overlaps a seeded event: the conflict is listed. Propose new time opens a draft containing the computed slots.
4. A plain question mail: a reply draft is created (with the fake body), the row badge is visible, and For you lists it.
5. A phishing fixture (display-link mismatch): the banner is shown and no draft is created.
6. A bulk `List-Id` newsletter: no model request is recorded.
7. Activity lists the actions, and Undo works.
8. Kite, Classic and dark mode render the card. Check the computed colour comes from the `blue-*` mapping, and take screenshots only on failure.
9. Daily limit set to 1: the second mail shows "Paused: daily limit reached".

### 11.3 Injection resistance

- **Deterministic (CI).** `e2e/22-auto-agent-injection.spec.ts`. The fake model plays a compromised model and returns hostile outputs:
  - triage JSON with extra `forwardTo` and `actions` keys;
  - a draft body containing an attacker address and URL;
  - a "summary" telling the user to wire money;
  - with Full auto, a non-allowlisted or unauthenticated sender asking to "auto-accept and reply".

  Assert that no send, move or forward happens (check Sent, `outbound_jobs` and message status), that `agent_actions` holds `blocked` rows, and that the draft is rejected or flagged. Unit counterparts go in `agent-auto-read-policy.test.mjs`.
- **Model evaluation (manual or nightly, never required in CI because it needs credentials).** `scripts/agent/injection-eval.mjs` runs a corpus `tests/fixtures/agent-injection/*.eml` (direct instructions, hidden HTML text, instructions in ICS DESCRIPTION, Unicode tag characters, fake system delimiters, base64 payloads, display-name spoofing) against the configured real model. It reports schema violations, flagged-versus-missed phishing, and any draft containing non-thread addresses or URLs. Gate the release on 0 policy breaches. Model quality is reported but does not gate the release.

## 12. Milestone plan (for a Factory Mission)

Work on `mission/auto-agent`. Every feature ends with `npm run check`, `npm run build`, `npm run build:node` and `npx playwright test` (or `npm run check:mission`), plus a new or updated test. Do not deploy, run remote migrations or rename resources.

**A. Data model and settings**

- Work: migration 0060, schema changes, backup lists (`export.ts`, `table-groups.ts`, `types.d.ts`), extended `GET/PUT /api/agent/settings` and `PUT /api/admin/agent`, and the "Automatic reading" settings UI (autonomy Off/Suggest only; Act and Full auto shown as unavailable until features F and H).
- Acceptance:
  - Existing `auto_draft_enabled` mailboxes become `suggest`.
  - An older backup restores after 0060, and a new backup round-trips.
  - The settings survive a reload.
  - A user without `canManage` cannot change autonomy (403).
- Tests: `backup-*` unit tests extended to the new tables, and an e2e settings round trip in `21-auto-agent`.

**B. Triage pipeline**

- Work: `scheduleAgentWork` hooked into both call sites in `inbound.ts`; the `agent.triage` queue kind in `worker.ts`, `server/index.ts`, `worker-utils.ts` and `env.d.ts`; `processAgentTriageJob` with leases, caps, the spend check, supersede and recovery; facts, triage parsing and the policy modules; `recordAiUsage` with `mailboxId`; the fake-model e2e infrastructure and the loopback flag.
- Acceptance:
  - Every eligible inbound message in an enabled mailbox (the gates in §5.1 and the skip rules in §9) gets exactly one triage job, even when delivered twice. Ineligible messages (spam, trash, own address, automatic mail, recovery older than 30 minutes) get none.
  - Spam, bulk and own mail never reach the model.
  - The caps stop jobs with a recorded reason, and concurrent jobs in different mailboxes cannot pass the install-wide cap together (the reservation in §7, item 8).
  - The flow works on Node (the consumer is registered).
- Tests: policy, parse and facts unit tests; a `SqliteDatabase` unit test where two mailboxes reserve against an install-wide cap that fits only one call; e2e scenarios 1, 6 and 9.

**C. Audit log and undo (Roadmap 5.2)**

- Work: `agent_actions` write-before-effect and `undoAgentAction`; `GET /api/agent/actions` and `POST /api/agent/actions/[id]/undo`; the Activity view.
- Acceptance:
  - Every agent and user decision on a suggestion appears in the log.
  - Undo restores the previous state, and is refused once `undo_until` has passed or without permission.
  - Blocked attempts are visible.
- Tests: unit tests for the inverse of each action, for resuming a stale `pending` row without repeating a side effect that already happened, and for Accept → Decline → Accept on one invite; e2e scenario 7.

**D. Suggestions UI**

- Work: the row badge (including the `/api/messages` addition), the reader card, the For you view and nav item, realtime `agent_suggestion`, and the reply-draft and summary capabilities (reusing the auto-draft generation).
- Acceptance:
  - Badges and the card appear without a reload after mail arrives.
  - Dismiss and Undo work.
  - Conversation view aggregates.
  - The UI renders in Kite, Classic and dark mode.
- Tests: e2e scenarios 4 and 8, and a unit test for the badge-priority helper.

**E. Calendar invites**

- Work: `ics-parse-utils.ts`, `availability-utils.ts` (`find_free_time` refactored onto it), `createCalendarReply`, the `calendar_events` columns, the Accept/Decline/Propose flows, and update and cancel handling.
- Acceptance:
  - Accept creates the event and sends METHOD:REPLY to the organizer only.
  - Propose offers only code-computed free slots inside working hours.
  - A higher SEQUENCE updates the event, and CANCEL suggests removal.
  - Shared mailboxes default to calendar off.
- Tests: ICS, availability and reply unit tests; e2e scenarios 2 and 3.

**F. Act with undo**

- Work: automatic folder/label, archive, mark read and remind (`snoozed_until`) actions, and tentative calendar holds; tasks and deadlines, and receipts filing.
- Acceptance:
  - Actions run only at `act` or above, each with an audit row and a working Undo.
  - The agent never trashes, marks spam or creates folders.
- Tests: the policy matrix, and e2e for a receipt being auto-filed and then undone.

**G. Follow-ups and unsubscribe**

- Work: a cron scan for sent mail with no reply (`runAgentMaintenance`, capped per run) that produces a nudge draft suggestion; a `List-Unsubscribe` suggestion with a click-only RFC 8058 POST.
- Acceptance:
  - No network call happens without a click.
  - The nudge is suppressed once a reply arrives.
- Tests: unit tests for the follow-up selection and e2e for both.

**H. Full auto for approved senders**

- Work: the `agent_sender_policies` CRUD and UI, the admin `agent_full_auto_allowed` setting, held scheduled sends (RSVP and template replies), and the auto-downgrade guard.
- Acceptance:
  - Only allowlisted, authenticated, non-suspicious senders trigger sends.
  - At most 1 automatic send per thread per 24 hours.
  - The send is visible as scheduled and can be undone.
  - The auto-downgrade guard fires.
- Tests: `22-auto-agent-injection` and the policy unit tests.

**I. Injection evaluation and docs**

- Work: the `scripts/agent/injection-eval.mjs` corpus, `docs/assistant.md` (privacy, costs, levels), and `CLAUDE.md` architecture notes on the auto-read pipeline. The docs contract (`npm run docs:check`) must pass.
- Acceptance:
  - The evaluation runs locally against a configured provider and prints a report.
  - The docs describe where content goes for each provider.

The first shippable slice is A through E (Suggest only). F, G and H are follow-up releases.

## 13. Decisions

Approved by the maintainer on 2026-10-10.

- Calendar holds: add a `status` column (`confirmed|tentative`) to `calendar_events` in feature E, and show tentative events as such in the calendar.
- Shared mailboxes: only users with full access to the mailbox see its suggestions and can act on them.
- Before feature B, spend a short spike evaluating the Cloudflare Agents SDK (Roadmap 5.1) against extending the existing `kite-agent` queue. Record the outcome in the PR; continue with the queue design unless the SDK is clearly better.
- Build Suggest only first (features A–E), then Act with undo and Full auto.

Still open, to settle during the Mission:

- Whether auto-draft stays a separate toggle or folds into `autonomy` and `capabilities`. This spec keeps it for compatibility at `off`.
- Whether Kimi K2.5 on Workers AI supports JSON mode or `response_format`, and whether reasoning should be off for triage. The spec parses with zod, so it does not depend on either.
