# Complete-suite roadmap (proposal)

Status: proposal for review, originally written on 2026-10-10 against `main` at `842f81d`, updated 2026-10-11 with milestones 20–25 and on 2026-10-14 against `main` at `17a04a3`, after [automatic reading](specs/auto-agent.md) ([#28](https://github.com/midego1/kite/pull/28)) and the builtin [module platform](specs/module-platform.md) ([#45](https://github.com/midego1/kite/pull/45)) shipped. It does not change the approved plan: [milestones 1–8](../ROADMAP.md) and the approved specs ([attachments-once](specs/attachments-once.md), [drive-storage](specs/drive-storage.md)) keep their order. This document proposes milestones 9–25 to follow them, for folding into `ROADMAP.md` once approved. Each milestone is sized to run as one Factory Mission, with a spec under `docs/specs/` written against `main` before it starts, exactly like the three approved ones.

The goal: Kite becomes an extremely complete, self-hostable workspace — mail, calendar, files, chat, docs, tasks, CRM and HR in one product — while staying **one Cloudflare Worker or one Node/Docker container**, not a microservice fleet. Communication is the spine: mail already gives Kite identity, contacts, threads, attachments and an agent pipeline. The other modules hang off that spine.

## The promise: one product, many ways to run it

Customizability is the key selling point. The same code path must keep supporting every way to run Kite:

1. **One-click, 100% Cloudflare.** The Deploy button provisions the Worker, D1, R2, Queues, Email Routing, cron and Workers AI; Kite's core and first-party features do not require an external integration service. Optional connectors may use a service the operator or user explicitly selects, with the added dependency and data flow clearly disclosed.
2. **Kite-hosted cloud plans.** A managed Kite Cloud workspace should work out of the box with Kite-operated infrastructure. Customers may choose supported provider options or bring their own credentials where the runtime, security model and plan allow it; this is a separate offering from deploying Kite into their own Cloudflare account.
3. **Self-hosted in Docker.** One container from `docker-compose.yml`: SQLite file, file bucket, in-process queues and its own SMTP listener, with inbound through the relay Worker when the host is not public.
4. **Mix and match providers.** Already pluggable today: mail sending and receiving per domain (Cloudflare, Resend, SES), AI (Workers AI or any OpenAI-compatible endpoint), object storage (R2 now, any S3-compatible store from milestone 7), alerting webhooks. A hosted SQLite-compatible database joins the matrix in milestone 17.

Every new module inherits this promise: no feature may hard-bind to one provider, credentials stay encrypted with `APP_ENCRYPTION_KEY`, and each provider's Setup stays per-domain with its own clean-up, like the existing sending and receiving providers. A module that only works in one of the deployment modes is not done. Provider choices are a separate axis from plan tiers: tiers can set resource, usage and support limits, while modules and compatible providers remain selectable where feasible.

Kite should also grow into a customizable **Life Space** for individuals, teams, businesses and organizations: private personal dashboards alongside shared team and organization spaces, built from first-party modules and permissioned third-party widgets. Mail, calendar, tasks, files, portfolio information and connected services can come together in one place without collapsing their access boundaries. Users and organizations choose what to add and arrange it; connected data stays private by default and is shared only with explicit permission. The integration promise is broad, not "send arbitrary requests anywhere": connectors must be scoped, reviewable, secure, and supported on the selected runtime.

## Where the bar is: Huly / Platform

[Platform](https://github.com/Platform-Collective/platform) — the independently developed fork of [Huly](https://github.com/hcengineering/platform) by Hardcore Engineering — markets itself as an all-in-one replacement for Linear, Jira, Slack, Notion and Motion. It is a genuine complete workspace: 30+ microservices (CockroachDB, Elasticsearch, MinIO, Redpanda, Redis, Jaeger), a Rush monorepo of ~70 product plugins, and a self-hosted footprint of roughly 35 GB. Huly is also now bolting on its own mail/communication layer (`huly-mail`, `inbox`, `communication`, `love`), which confirms the direction: every serious workspace converges on communication-first.

Kite's structural advantage is the deployment story. Huly self-hosting is a compose file over a dozen-plus stateful services, and its customization ends at "run all of it, on their stack". Kite self-hosting is one container (or one Worker deploy) with SQLite-compatible storage, a file bucket, in-process queues and its own SMTP listener — and the provider matrix lets an operator pick Cloudflare mail, Resend or SES; R2 or any S3-compatible store; Workers AI or their own model endpoint; file, D1 or (proposed) hosted SQLite. That is the difference between "self-hosted for whoever wants" and "self-hosted for whoever operates a database fleet".

### Feature survey (from their plugin and service trees)

| Their module | What it is | Kite status |
| --- | --- | --- |
| `tracker`, `task`, `board`, `view`, `workbench`, `gantt` | Issues, projects, Kanban boards, sprints, saved views, all-up workbench, Gantt | Proposed milestone 11 |
| `chat`, `chunter`, `pulse`, `presence`, `emoji` | Team chat, comments on everything, notifications, online status, reactions | Proposed milestone 9 |
| `document`, `text-editor`, `controlled-documents`, `diffview`, `templates` | Docs/knowledge base, collaborative editing, QMS-style controlled documents, version diffs | Proposed milestone 10 |
| `drive`, `attachment`, `uploader`, `media`, `preview`, `converter`, `inventory` | File storage, uploads, media processing, thumbnails, asset inventory | Storage and Drive: milestone 7; previews and inventory: milestone 17 |
| `contact`, `lead`, `client`, `support`, `request` | Contacts, leads, client portal, helpdesk, request queue | Contacts exist; CRM and support desk: proposed milestone 12 |
| `recruit`, `gmail`, `telegram`, `bitrix`, `github-next`, `integration` | Applicant tracking, provider integrations | Proposed milestone 13 (ATS) and 17 (integrations) |
| `hr`, `time` | People, time off, attendance, timesheets | Proposed milestone 14 |
| `questions`, `survey`, `qalico`, `process` | Forms, surveys, workflow automation | Proposed milestone 15 |
| `ai-assistant`, `ai-bot`, `openai` | AI assistant in chat, AI bot | Exists (milestone 5 pipeline); chat surface in milestone 9 |
| `huly-mail`, `inbox`, `communication`, `love` | Their new mail and unified inbox | **Kite's core**; JMAP, MCP, providers, spam engine already ahead |
| `calendar`, `recorder`, `stream`, `media` | Calendar, call recording, video streaming | Calendar and booking exist; video: not planned (integrate instead) |
| `billing`, `payment`, `products`, `billing-client` | SaaS payments and product catalog | Not planned — no licensing; operators build on the API |
| `guest`, `login`, `onboard`, `global-profile`, `setting`, `preference`, `admin` | Guests, auth, onboarding, profiles, settings, admin | Auth, admin and settings exist; guests and SSO in milestone 17 |
| `activity`, `notification`, `rating`, `tags`, `export`, `print`, `sign` | Activity feeds, notifications, ratings, tags, export, PDF print, e-sign | Notifications in milestone 9; print/e-sign/export in milestone 17 |
| `achievement`, `training`, `test-management`, `qms-tests` | Gamification, LMS, test management (QMS) | Ideas only, off by default if ever |
| `desktop`, `desktop-downloads`, `desktop-preferences` | Desktop app | Milestone 17 (PWA first, optional wrapper) |
| Collaborator service | Real-time co-editing over Y.js CRDT | Proposed milestone 10, via the Durable Object |
| Fulltext service | Elasticsearch indexing | FTS5 pattern (`messages_fts`) instead, per entity |
| Rekoni service | Document/resume parsing | Workers AI or the pluggable agent provider |
| Datalake / MinIO | Blob storage | R2 / milestone 7 storage providers |
| Backup service | Workspace backups | Exists |
| Upstream Huly `wiki`, `whiteboard`, `goal` | Wiki, whiteboard, OKRs | Docs cover wiki (milestone 10); whiteboard and goals are ideas — the fork itself has dropped them |

## Rules that apply to every new module

Same rules as `ROADMAP.md`, plus what the architecture demands:

- Every module is a switchable module (the existing idea: an admin toggle, a per-user permission, hidden UI and 404 API when off). A mail-only install must never see chat, CRM or HR.
- One code path, two runtimes: everything works on Workers (D1, R2, Queues, Durable Objects, Workers AI) and on the Node/Docker runtime (better-sqlite3, file bucket, in-process queues, in-process hub). `getEnv()` only; no `isNodeRuntime()` in feature code.
- Provider seams stay pluggable, per the promise above: a module that needs a model calls the existing agent provider config, a module that needs storage calls the milestone 7 storage interface, and a module that needs mail calls the existing outbound provider resolution. No new provider is introduced without its Setup, clean-up and a documented self-host path.
- Search is FTS5 per entity with triggers, like `messages_fts`; never a search service.
- Realtime rides the existing `RealtimeHub` Durable Object; presence and collaborative editing get their own DOs.
- New tables go into the backup lists in the same change (`AGENTS.md`), with migration journal entries.
- Mail is the link layer: every entity (chat channel, doc, task, deal, candidate, person) can point at the mail threads it came from, and the reader can create or attach the entity.
- The agent pipeline (milestone 5) treats new entities as tools and audit targets: deterministic code decides, the model proposes, everything audited and reversible.
- No new infrastructure dependencies: no Elasticsearch, no Redis, no Kafka, no Mongo/Cockroach. A queue is `kite-*` in Queues; a cache is D1 or KV.

## Milestone 9: Team chat and presence

1. **Channels and direct messages**
   - `chat_channels`, `chat_messages`, `chat_members`: public channels, private channels, DMs, per-user unread state.
   - Full-text search over messages via a trigger-kept FTS5 table.
   - Test: e2e for creating a channel, posting, unread counts and search.
2. **Threads, reactions, mentions, attachments**
   - Threads and reactions like the rest of the workspace (emoji picker, @-mentions resolving to users).
   - Attachments come from Drive (milestone 7) or straight from a mail message: "share to channel" posts a card with the message snapshot and a link back to the thread.
   - Link previews: safe fetch of OpenGraph metadata, rate-limited and size-capped, stored rendered like mail remote images (allowed only after review).
   - Test: unit tests for the link preview sanitizer; e2e for threads, reactions and sharing a mail message into a channel.
3. **Mail ↔ chat bridge**
   - A `domain`-scope routing rule can post inbound mail into a channel (the same three-phase resolution, a new `forward`-style action target).
   - Channel replies can go out as email from the channel's address; both directions keep the thread link.
   - Test: e2e delivers mail to a channel, replies by email, checks the linkage.
4. **Presence and notification center**
   - Online/away via the realtime WebSocket; a unified notification center (new mail, mentions, assignments, upcoming events) with per-type muting, replacing the current per-feature toasts where they overlap.
   - Test: e2e for presence state and notification list with muting.
5. **Assistant in channels**
   - The chat assistant answers in channels with `origin: "chat"` semantics (read-only tools, approvals for sends), using the existing agent stack.
   - Test: e2e asks a question in a channel and gets a grounded answer.

## Milestone 10: Docs and knowledge base (needs milestone 7 Drive)

1. **Spaces and pages**
   - `docs_spaces`, `doc_pages` (nested), per-space permissions aligned with `mailbox_access` sharing semantics.
   - The composer's contentEditable pipeline (`rich-text-editor.tsx`, `htmlToPlainText`, sanitizing) is the editor; no new editor dependency.
   - Version history: snapshots in storage per save, restore an old version; diffs are rendered like thread changes, not a diff service.
   - Test: e2e for creating, nesting, editing, restoring a version; search finds a page.
2. **Collaborative editing**
   - A Durable Object per open document sequences edits and broadcasts presence; concurrent paragraph edits merge deterministically (per-block last-writer-wins first; full CRDT only if proven necessary).
   - Test: two browser contexts edit simultaneously without losing content (e2e with two pages).
3. **Save mail as a doc**
   - From the reader: save the sanitized body as a new page, linked back to the message; batch-save a whole thread into one page.
   - Test: e2e saves a message and a thread, and the page links back.
4. **Templates and controlled documents (optional module)**
   - Page templates; a controlled-document mode with numbering and an approve step for teams that want QMS-lite.
   - Test: e2e for template use and an approval flow.
5. **Comments and activity**
   - Comments on pages reuse the chat engine; page activity feed and notifications.
   - Test: e2e comment and notification round trip.

## Milestone 11: Projects and tasks

1. **Issues**
   - `projects`, `tasks` with custom types, per-project statuses (workflow), priority, labels, components, assignees, due dates, estimates.
   - Trigger-kept FTS5 index; saved filters; new tables in the backup lists.
   - Test: e2e full task lifecycle; unit tests for workflow transitions.
2. **Boards and sprints**
   - Kanban views (drag between statuses), sprints with start/end, backlog, per-sprint and per-assignee roll-ups.
   - Test: e2e drag a card, sprint a project, check roll-ups.
3. **Relations and activity**
   - `blocked by`, `relates to`, `duplicates` links; full activity log per task.
   - Test: unit tests for relation cycles; e2e activity feed.
4. **Mail → task, agent-created tasks**
   - "Create task from message" pre-fills title, description, sender and attachments; the thread link stays.
   - The auto-agent (milestone 5) can create or update tasks within the mailbox autonomy level, audited in `agent_actions` and reversible.
   - Test: e2e creates a task from mail; agent triage creates a filed task with an undo.
5. **Timeline and time tracking (optional)**
   - Read-only Gantt-style timeline over scheduled tasks; work logs per task and per-user timesheets.
   - Test: e2e logs time and reads the timesheet.

## Milestone 12: CRM and support desk

1. **Companies and enriched contacts**
   - `companies`; existing `contacts` gain a company, role and fields; dedupe on import and merge.
   - Test: e2e merges duplicate contacts; unit tests for dedupe keys.
2. **Deals and pipelines**
   - `deals` with pipelines, stages, value and expected close; board reuses milestone 11 views.
   - Test: e2e moves a deal through a pipeline.
3. **Mail timeline**
   - Per contact/company view listing every inbound and outbound thread, auto-linked by address (the `contacts` upsert pipeline already resolves senders).
   - Test: e2e checks a contact shows the thread that created it.
4. **Support desk**
   - A routing rule per mailbox routes `support@`-style mail into a support queue (new statuses, assignment, SLA timestamps, canned replies).
   - The agent drafts replies for approval (`origin: "auto"` never sends); everything audited.
   - Test: e2e routes mail to the queue, claims it, replies from a template.

## Milestone 13: Recruiting (ATS)

1. **Openings and candidates**
   - `job_openings`, `applications` with pipeline stages on the board from milestone 11; resumes stored as attachments (single copy, per attachments-once).
   - Test: e2e pipeline stage changes and assignment.
2. **Resume parsing**
   - Rekoni-equivalent extraction (name, contacts, skills, experience) through Workers AI or the configured OpenAI-compatible provider, like the agent model config; deterministic code stores the result, the model never writes the database directly.
   - Test: fixture-based unit tests for extraction and validation.
3. **Interview scheduling**
   - Booking links per pipeline stage; candidate threads live in mail with the candidate contact; outreach templates.
   - Test: e2e books an interview and the calendar shows it.
4. **Public apply form (optional)**
   - Rate-limited public form (the `BOOKING_RATE_LIMIT` pattern) feeding applications.
   - Test: e2e applies through the form, including the rate limit.

## Milestone 14: HR and people

1. **People profiles**
   - `people` records for employees beyond login users; manager field for an org chart; a profile page aggregating mailbox, calendar, tasks and deals.
   - Test: e2e org chart and profile aggregation.
2. **Time off**
   - Leave types, balances, request/approve; approved leave shows in the calendar and blocks booking availability (the free/busy computation already builds blocks).
   - Test: e2e requests leave, approves it, and booking reflects it.
3. **Attendance and timesheets (optional)**
   - Feeds from milestone 11 time tracking; CSV export.
   - Test: e2e export.

## Milestone 15: Forms, surveys and automation

1. **Form builder**
   - Fields, public link, rate limiting; responses in D1 with notifications; exportable.
   - Test: e2e submits a form and reads responses.
2. **Automation rules**
   - Trigger (mail arrives, task changes, form submits, doc updates) → conditions → actions (notify, label, move, create task, call a webhook). Deterministic evaluation with the routing-rule machinery and its ReDoS guards; every run audited. The agent can propose a rule, code validates it, the user approves it.
   - Test: unit tests for the rule engine; e2e for a mail-triggered automation.
3. **Shared reply templates**
   - Template library with variables for support and recruiting, usable from the composer and the agent.
   - Test: e2e inserts a template.

## Milestone 16: Collaboration extras

1. **Guest access**
   - External guests with scoped access to exactly one channel, doc or board; no mailbox access, ever; audit of guest actions.
   - Test: e2e guest sees only the shared channel; API 404 elsewhere.
2. **Workspace templates**
   - Ship template sets (space + project + board + canned replies) applied in one action.
   - Test: e2e applies a template.
3. **Whiteboard (optional module)**
   - Canvas stored in Drive; presence via the doc DO; PNG export. Off by default; revisit demand before building.

## Milestone 17: Platform completeness

1. **Global search** — one search bar across mail, chat, docs, tasks, deals, people and files (per-entity FTS5, merged and ranked); the current mail grammar (`src/lib/search/`) becomes the shared front end. Test: e2e finds mail, a page and a task from one query.
2. **File previews and thumbnails** — image and PDF previews inline, attachment thumbnails, Drive preview page; client-side rendering first so it works on both runtimes. Test: e2e preview of an image and a PDF attachment.
3. **Pluggable database (self-hosted)** — add a hosted SQLite-compatible provider (libSQL/Turso) behind the existing `getDb()` seam, so a self-hosted install can run a managed database instead of a file, with credentials encrypted like the other providers and the D1/SQLite dialect and FTS5 search unchanged. Test: unit tests for the driver seam; e2e against a local libSQL server.
4. **Importers** — CSV-first import for Jira, Linear, Trello and Asana into milestone 11; then their APIs where available. Test: fixture-based unit tests plus an e2e with a small CSV.
5. **Integrations** — GitHub issue sync (two-way, per-repo), a Telegram bridge (messages in/out like the mail bridge), generic inbound webhooks as automation triggers. Test: e2e where possible; recorded-response unit tests for GitHub.
6. **Print and PDF** — print stylesheets for docs, tasks and deals; browser print-to-PDF (no headless Chrome on Workers). Test: e2e checks the print view renders.
7. **E-sign (optional)** — request a signature on a Drive document: content hash, audit trail, signed copy stored back. Deliberately simple; not a qualified timestamp service. Test: e2e sign flow.
8. **SSO** — SAML and OIDC login for organizations (self-hosted especially), invitation flow, no lock-in with local accounts. Test: e2e with a local OIDC test provider.
9. **Desktop and mobile** — PWA install polish, push notifications through Web Push, optional desktop wrapper; offline reading stays the existing idea.
10. **Analytics dashboards** — admin dashboards over existing metrics (mail volume, storage by class, agent usage, automation runs), CSV export. Test: e2e renders the dashboard.
11. **Full i18n** — grow the milestone 1 message catalog to the whole UI with community translations.

## Milestone 18: Subscriptions (money watch)

Position note: **shipped in [#50](https://github.com/midego1/kite/pull/50)**, specified in [the Money Watch spec](specs/money-watch.md). It extends the auto-agent pipeline (milestone 5) and is a builtin module on the module platform (milestone 19, item 1). What shipped differs from the outline below in these decided points: the module id is `finance` (display name Money Watch; page `/finance`, record kind `finance:subscription`, scope `mcp:finance-read`); the webhook events are `finance.subscription.detected` and `finance.subscription.renewal_due`; the tables are `finance_subscriptions` and `finance_charges` (migration 0063, both in the backup lists); the validated `subscription` object comes from a generic, descriptor-declared module model extension of the existing triage request, asked for only when the deterministic detector needs help; and a document ledger (`finance_charges`) keeps each invoice, payment, credit note, refund and failed payment with a reference to its message and attachment, giving each vendor's history and a 12-month paid total. One-off purchases and general expense tracking are a later, advanced item. Filing ledger documents into Drive is a follow-up for after Drive ships (ROADMAP milestone 7; [§24 of the spec](specs/money-watch.md#24-drive-filing-follow-up-after-drive-ships)).

1. **Detection and extraction**
   - Deterministic first (D), on the auto-agent's facts layer: invoice and receipt heuristics (subject and sender keywords, amount patterns, PDF or image attachments), a recurring sender-plus-amount seen before, and the `List-Unsubscribe` header as the cancel link.
   - The LLM triage result gains a validated `subscription` object (vendor, plan, amount, currency, cycle, next renewal date, trial end). Code validates dates (within 2 years) and amounts; the cancel URL comes only from `List-Unsubscribe`, never from the message body or the model output. External-provider reading obeys `agent_external_auto_read_allowed` like every triage.
   - A new suggestion kind `subscription`: "Netflix $17.99/month, renews 1 Nov — track it?", linked to the source message. The module contributes detection as a `triage_step` capability and the kind as a `suggestion_kind` capability, so automatic reading stays free of Money Watch code and skips both while the module is off.
   - Test: unit tests for the deterministic detector and the extended triage schema; e2e delivers a synthetic invoice and accepts the suggestion.
2. **The subscriptions database**
   - `subscriptions` table: vendor (linked to `contacts`), plan, amount, currency, cycle, `next_renewal_at`, trial end, status (`active | trial | cancelled | expired`), source message, and per-item reminder days. The owner is the mailbox's reviewer user.
   - Accepting a suggestion writes the row through `agent_actions` (`create_subscription`) with undo. Only autonomy `off` and `suggest` can be saved today (`autonomyError`), so this milestone is suggestion-only; creating rows automatically waits until an Act level ships. Manual add works from any message and by hand. A recurring invoice updates the row and flags price changes ("increased from $14.99").
   - Test: e2e accepts a suggestion, checks the row, undoes it; a second invoice from the same vendor updates the renewal date and shows the price-change flag.
3. **Renewal, payment and cancel nudges**
   - A module cron task (manifest `cronTasks` with a `cron` descriptor, run by `runModuleCronTasks` on both runtimes) finds subscriptions inside their reminder window and emits the realtime notification, a Subscriptions badge, and an optional calendar event per item. The calendar event goes through `moduleHost.invoke` to a Calendar `service` and is skipped when Calendar is off for the user.
   - "Cancel before 1 Nov" uses the stored one-click `List-Unsubscribe` link, click-only (the same rule as newsletter unsubscribe). Failed-payment keywords flip the item to urgent.
   - Test: e2e advances a subscription into the window and checks the notification, the badge and the calendar event.
4. **The Subscriptions view**
   - A page in the module's own route group, with its nav item declared in the manifest: upcoming renewals first, monthly and yearly totals, vendor history linked to its mail threads, edit, status changes, per-item reminders. Checked in Kite, Classic and dark mode.
   - Test: e2e lists items, edits a reminder setting and cancels one.
5. **Rules and guardrails**
   - Detection obeys the mailbox autonomy level (Off means no automatic reading; manual add still works). Every write is audited in `agent_actions` and reversible. Works on both runtimes; new table in the backup lists; no new provider or infrastructure.
6. **A builtin module on the existing platform**
   - Money Watch is the first new module added to the shipped registry, following "Adding a builtin module" in [Modules](modules.md); it does not introduce its own registry or helpers. The spec picks the module id (existing ids are single words such as `calendar`). A manifest in `src/lib/modules/<id>/` (listed in `MODULE_MANIFESTS`), JSON capability descriptors, handlers reached only through `invokeCapability`, implementation in `src/lib/<id>/`, and core reached only through `ModuleHost`. `tests/module-imports.test.mjs` and `tests/module-registry.test.mjs` keep passing.
   - The owner turns it off for the install or per user from Admin → Modules. Off means absent: no nav item, suggestions, cron work, tools or events; pages answer 404 through `requireModulePage` and every API method through `withModule`; data is kept. The spec decides `defaultEnabled`.
   - A record kind (`<id>:subscription`) with a `resolveRefs` resolver, and webhook events (`subscription.detected`, `subscription.renewal.due`) declared in the manifest with record refs, so they appear in webhooks, search, For you and Activity like Calendar's.
   - The assistant suggesting "enable Money Watch for this invoice PDF" while the module is off stays in milestone 19, item 5.
   - Test: extend `e2e/27-modules.spec.ts` (or a sibling spec) to turn Money Watch off and on and check nav, pages, API, suggestions and cron behavior.

## Milestone 19: Module platform and app directory (the extendable core)

Position note: approved and taken first, in [the module platform spec](specs/module-platform.md), with **builtin modules first and sandboxed apps inside your own Kite later**. Instead of waiting for new modules, the registry is extracted from four that already exist (Calendar, Booking, Email templates, Mail import), so it is still generalized from real modules rather than guessed. This supersedes the earlier "external apps are separate services" model and the matching line in `ROADMAP.md`'s Ideas section: an app is a signed bundle that runs sandboxed inside the user's own Kite (Dynamic Workers on Cloudflare, a workerd sidecar on Node and Docker), never on a publisher's servers, and it uses the same capability descriptors and JSON call contract as a builtin module. Later modules (18, 9–12) register through the same platform.

1. **Builtin module registry (shipped in [#45](https://github.com/midego1/kite/pull/45))**
   - Each module has a client-safe manifest (pages, API prefixes, nav, UI commands, composer slots, record kinds, webhook events, scopes, queue message types, cron tasks) and JSON capability descriptors with server-side handlers. Core reaches module code only through `invokeCapability`, and modules reach core only through `ModuleHost`. The owner turns modules off for the install or per user from Admin → Modules; off means no UI, commands, tools or events, 404 pages and API, and no queue or cron work, and it never deletes data. Mailbox export stays core. See [Modules](modules.md).
   - Test: unit tests for the registry, the call contract, import rules and guards; e2e for every shipped module: toggle off, check nav, pages, API, assistant tools, MCP, webhooks and background work, then on again.
2. **Module events and refs (shipped in [#45](https://github.com/midego1/kite/pull/45))**
   - Module events go through the existing webhook system (`calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted`, `booking.appointment.created`, each with a record ref), listed and sent only while the module is on. Later modules add theirs, such as `subscription.renewal.due`, the same way.
   - Test: unit tests for the event list and emitter; e2e checks the event list follows module state.
3. **Sandboxed apps inside your own Kite (later, separate spec)**
   - Signed bundles the owner installs and approves grants and network hosts for. They run with no network by default, per-call CPU limits and a per-app log, reach core only through a `KiteHost` RPC surface that mirrors `ModuleHost`, and contribute UI through commands and record refs, not injected React. Without the Worker Loader binding they show as unavailable and builtin modules keep working.
   - Test: e2e installs a synthetic signed app, checks its capabilities appear in the assistant, MCP and search, that ungranted calls are refused, and that disabling it removes them.
4. **App directory**
   - A directory of reviewed manifests for first-party modules and sandboxed apps, with free and paid listings, capability/permission disclosure, publisher identity, supported runtime, versioning and uninstall/data-revocation behavior. Paid plugins are part of the product goal; settle checkout, entitlements, renewals, refunds, fees and tax responsibilities before Kite handles transactions. A first release may use developer-managed billing, but the platform must not make paid apps impossible to add later.
   - Test: e2e for free install, paid entitlement grant/revoke, uninstall, grant changes and cleanup.
5. **AI-suggested apps**
   - The assistant maps detected content to module capabilities and directory apps: an invoice PDF with Money Watch off suggests enabling it; directory search answers "which app handles X"; every suggestion links to the install flow. The model proposes; code validates against the registry.
   - Test: e2e delivers an invoice with the module off and checks the enable suggestion appears and works.

## Milestone 20: Newsletters and audience management

Position note: a first-party optional module built on Kite's mail, contacts, sending-provider and queue seams, after the module registry exists. This is **publishing newsletters to opted-in audiences**, distinct from milestone 18's Money Watch, which tracks subscriptions the user pays for. Mailcheap is a useful feature reference, not a deployment template: it is built around SES, MongoDB and QStash, while Kite must preserve its Cloudflare and Docker paths.

1. **Audiences and consent**
   - Multiple newsletters/audiences, contacts with consent source and status, confirmed opt-in, welcome and confirmation messages, safe CSV import/export, suppression for unsubscribes, bounces and complaints.
   - Public signup forms and a rate-limited API; prevent accidental resubscription of suppressed contacts and retain consent history.
   - Test: e2e signup, confirmation, unsubscribe, CSV import and suppression behavior.
2. **Campaign authoring and sending**
   - Editor with preview, test send, scheduling, audience selection, send pacing/batching, progress and pause/resume; validate sender domain, postal address, unsubscribe link and message size before sending.
   - Use existing outbound provider resolution and queues, with provider-specific capabilities made explicit. No feature may silently bypass provider limits or turn a newsletter into an unbounded bulk-send API.
   - Test: synthetic campaign on the fake provider, including retry/idempotency, pacing, cancellation and provider failure.
3. **Deliverability and compliance**
   - One-click unsubscribe (RFC 8058), complaint/bounce event ingestion where the chosen provider supports it, shared suppression, automatic pause at configured safety thresholds, and sender-domain setup guidance.
   - Do not send to purchased/scraped lists. Require an explicit confirmation step before a campaign is sent; AI may help draft or segment, but cannot enroll people or send without the user's approval.
   - Test: unsubscribe headers and click path, bounce/complaint suppression, threshold pause and permission checks.
4. **Issue archive and reporting**
   - Public, sanitized archive pages per newsletter, with optional custom domain only where the hosting mode supports safe isolation; campaign reports for delivery, bounce, complaint, opens and clicks, with tracking opt-in/configurable.
   - Test: e2e archive sanitization, campaign report and tracking preferences.
5. **Module and provider behavior**
   - Off by default until enabled, with module permissions and API isolation from milestone 19. Works on Cloudflare and Node/Docker; uses the active database and object-storage providers, and the configured mail sender. Setup shows which analytics and event features the selected sender supports.
   - Test: module-off behavior and provider capability matrix; no MongoDB, QStash or SES-only dependency.

## Milestone 21: Kite Cloud plans and provider selection

Position note: a managed-cloud product and deployment-control-plane milestone, not a change to the self-hosted app's license or an assumption that every backend can be swapped at runtime. Depends on the provider seams in milestone 17 and the module registry in milestone 19. First decide whether customer workspaces are isolated deployments or safely shared tenants; do not assume the current single-install app is already multi-tenant.

1. **Plan and package model**
   - Offer a fully managed default plan first, then define packages from measured compute, storage, email, AI usage, backup and support costs. Keep plan entitlements and quotas separate from module enablement and provider choice.
   - Validate plan names, quotas and pricing with real cost data; do not hard-code prices into this roadmap or gate basic mail safety behind a paid tier.
2. **Workspace provisioning and lifecycle**
   - Account/control-plane flow to create a Kite Cloud workspace, select a region where available, configure a custom domain, show health and usage, upgrade/downgrade, export data, and request deletion.
   - Include backups, migration/restore, isolation, operational monitoring and recovery in the acceptance criteria. Keep the control plane small and distinct from the Kite application runtime.
3. **Supported provider choices**
   - Present an explicit compatibility catalog, not arbitrary provider dropdowns: database choices remain SQLite-compatible (D1 by default, hosted libSQL/Turso only after milestone 17); object storage is R2 by default with supported S3-compatible options; AI is Workers AI by default with optional BYOK OpenAI-compatible providers; mail remains selectable per domain through the existing provider setup.
   - For each choice, show who owns the account and bill, data location, feature limitations, credentials/privacy implications, health checks, migration/export path and whether it is supported on the selected plan. A Worker cannot use every service merely because it has an HTTP API; test reachability, latency and operational fit before listing it.
4. **Cloud billing and usage**
   - Meter plan quotas and provider usage, warn before limits, and connect Kite Cloud subscription billing through a separate hosted control-plane integration. This does not add a payment rail to Kite's self-hosted core or the third-party app directory.
   - Test: plan changes, usage accounting, quota enforcement and export/delete lifecycle in an isolated cloud test environment before launch.

## Milestone 22: Customizable dashboards and Life Space

Position note: make dashboards a first-class Kite surface for personal, team and organization use, not a collection of bespoke pages. It depends on the module/widget contract from milestone 19; finance and external-service widgets arrive through later modules/connectors. Dashboard scope must never silently change the visibility of the underlying mail, calendar, portfolio or other data.

1. **Personal, team and organization dashboards**
   - Users can add, remove, arrange and resize widgets on private dashboards. Teams and organizations can publish shared dashboards or templates for approved members, with per-user customization where allowed. Widgets can include inbox highlights, calendar, tasks, files, notes and module-provided content.
   - Test: e2e creates and personalizes each dashboard scope, persists layouts, and checks responsive behavior.
2. **Widget contract**
   - A typed, versioned manifest declares widget identity, settings, required permissions, data source, refresh behavior, supported runtimes and allowed scope (`user`, `team` or `organization`). Built-in modules and approved apps use the same contract; widgets receive only data authorized for the viewer and requested scope.
   - Test: contract validation rejects unknown permissions, invalid scopes and incompatible versions; e2e confirms a revoked permission hides the widget and its data.
3. **Sharing, roles and governance**
   - Personal dashboards are private by default. Sharing a dashboard or widget is explicit and scoped, with a clear preview of which data becomes visible. Organization admins can manage shared templates and membership but cannot use dashboard sharing to bypass mailbox, calendar or other entity-level permissions; changes are auditable.
   - Test: multi-user e2e covers owner, member and admin access, sharing and revocation, and verifies private data stays inaccessible through both UI and API.

## Milestone 23: Connections and API aggregation

Position note: a secure connection layer for the Life Space and marketplace, not an unrestricted server-side proxy. Kite owns the stable connector contract, marketplace, permissions and consent. Connector execution is replaceable: use a Kite-native adapter where it fits, or let an operator/user opt into an external integration backend such as Executor.sh. No external backend is required for Kite to run, and an integration backend must never become a hard dependency of the core product.

1. **Connection vault and consent**
   - Users or organization admins connect a service using OAuth where available or a provider-generated API key. Connections have an explicit owner and scope (personal or organization-shared); request least privilege (read-only by default), show exactly what data will be read, disclose where credentials and data are processed, and allow disconnect/revocation and data deletion.
   - When Kite stores credentials, encrypt them at rest. When a selected external backend stores or resolves credentials, make that custody explicit and validate its isolation, encryption, revocation and export guarantees before enabling it.
   - Test: consent, credential handling, revocation, token refresh and cross-user/cross-organization isolation; secrets never appear in logs or browser-readable responses.
2. **Connector and widget SDK**
   - A versioned SDK/manifest lets first- and third-party connectors expose typed read models, events and dashboard widgets. Keep a stable Kite adapter interface so integrations can be backed by direct provider APIs, Executor.sh, MCP or another compatible service without changing Kite's app/permission model. Support signed, replay-resistant webhooks and bounded polling where outbound API access is supported; expose provider rate limits and freshness.
   - Test: synthetic connector handles verified webhook delivery, deduplicates replay, respects rate limits and publishes only its declared data.
3. **Optional integration backends**
   - Offer external backends such as Executor.sh only as explicit, per-install or per-organization options. Evaluate self-hosted and hosted modes separately for Cloudflare and Node/Docker compatibility, secret custody, tenant isolation, licensing, supported actions, availability, versioning and data export.
   - A workspace with no backend configured must still run Kite normally. Failure or removal of an optional backend affects only the connections routed through it; users can disconnect or migrate those connections without losing unrelated Kite data.
   - Test: no-backend and backend-outage behavior, adapter contract tests, and a migration/disconnect flow using a stub backend.
4. **Safe generic integrations**
   - Offer a constrained API/webhook connector for common REST/JSON services: explicit host and path configuration, approved HTTP methods, response-size and timeout limits, schema mapping, secret redaction, and egress/SSRF protections. No arbitrary user-supplied code or unrestricted URL fetches. Any future write action requires a separately granted scope and an explicit approval flow.
   - Test: unit/e2e coverage for private-address and redirect SSRF attempts, oversized responses, malformed payloads, signature failures, secret leakage and write-scope denial.
5. **Operations and portability**
   - Show connection health, last successful sync, rate-limit/error state and data freshness. Export or delete connection data on disconnect. Keep connector behavior compatible with Workers and Node/Docker, and document any provider that cannot run on a given deployment.
   - Test: e2e for disconnect/export, degraded provider status and both runtime adapters.

## Milestone 24: Read-only stocks and crypto portfolio

Position note: a first-party optional finance module for visibility and organization, not a brokerage or financial-advice product. It depends on the Life Space widget contract (22) and connector infrastructure (23). It is planned as its own module with the id `portfolio`, separate from Money Watch (`finance`, milestone 18): the two share no data, have different privacy rules and depend on different infrastructure, so they keep separate owner switches.

1. **Portfolio overview**
   - Aggregate user-authorized holdings, cash balances and transactions where supported; show allocation, value history, dividends and watchlists with source, currency and last-updated time. Add a manual/CSV path for unsupported providers.
   - Test: synthetic portfolio fixtures cover currencies, splits/transactions, missing prices, stale data and import/export.
2. **Broker and exchange connectors**
   - Start with official broker APIs that support appropriately scoped read-only access, including Trading 212's official [Public API](https://docs.trading212.com/api), after validating its current endpoint and permission model. Add other brokers/exchanges through individual connector specs, not an unverified "all brokers" promise.
   - Never request, store or use order-placement/trading permissions. Never place, amend or cancel trades. Wealthsimple is a candidate only if an officially supported API or a reviewed, consent-based aggregator offers the required read-only data; otherwise use CSV/manual import.
   - Test: connector permission checks prove every requested scope is read-only; provider contract tests use synthetic data, never real account credentials.
3. **Market data and alerts**
   - Use an explicitly selected market-data source for stock and crypto prices; identify delayed/live status, source and timestamp, and handle missing markets/currencies transparently. Let users create price/portfolio threshold alerts without executing trades.
   - Test: deterministic valuation and alert tests across time zones, currency conversion, stale/missing quotes and threshold crossings.
4. **Privacy and boundaries**
   - Personal brokerage data is private to its owner by default and never exposed to an employer through organization dashboards. An organization portfolio may include only explicitly authorized organization-owned accounts or data that its owner deliberately shares. No financial advice, automatic investment recommendation, or trading action; clearly label derived estimates and allow disconnect and deletion.
   - Test: multi-user and multi-organization access-control tests prove personal holdings cannot leak into a company dashboard; e2e covers disconnect and data deletion.

## Milestone 25: WebMCP support for browser agents

Position note: this exposes selected Kite page capabilities to compatible browser agents through the emerging WebMCP browser API. It is a Kite UI compatibility surface, **not** the external integration layer, a marketplace connector, or a replacement for Kite's server-side API/MCP. The WebMCP Community Group specification and browser support are still evolving, so ship only when the API and target browser support are stable enough; gate it behind feature detection and keep Kite fully usable without it.

1. **Page-scoped tools**
   - Expose a small, deliberate set of tools in the current authenticated Kite page, such as searching the user's accessible mail, opening the selected thread, or preparing a reply draft. Use the existing Kite UI/server paths and authorization checks; never expose database access, bearer credentials or tools outside the current user's permissions.
   - Test: supported-browser e2e verifies tool discovery and invocation, and that API authorization still rejects inaccessible mailbox/message IDs.
2. **Confirmation for changes**
   - Read-only tools may return only data the signed-in user could view in Kite. Draft creation or other state changes must use Kite's normal confirmation flow, idempotency and audit mechanisms; never send mail or perform another irreversible action solely because an agent invoked a WebMCP tool.
   - Treat email bodies, attachments and page content as untrusted input, not instructions to the tool. Do not let page content expand tool permissions or bypass the user's confirmation.
   - Test: e2e covers confirmation, cancellation, duplicate invocation and hostile instructions embedded in synthetic mail.
3. **Progressive enhancement**
   - Feature-detect WebMCP and register tools only in compatible browsers. Unsupported browsers retain the complete standard UI; server-side API/MCP clients and the external connector architecture remain independent.
   - Test: supported and unsupported browser paths, graceful fallback, tool removal on logout/session expiry, and permission changes during an open session.

## Deliberately not planned

- **Kite-operated checkout for paid apps in the first marketplace release** — free and paid plugins are in scope, but taking payments introduces entitlement, refund, tax and payout obligations. Begin with a clearly disclosed developer-managed payment flow if needed; revisit Kite-operated checkout as part of marketplace design. Kite Cloud plan billing is separate (milestone 21).
- **Trading or investment advice** — the portfolio module is read-only and informational.
- **Video meeting infrastructure** (their `stream`, `media`, `recorder`): no SFU in a Worker. Integrate Jitsi, LiveKit or Cloudflare Calls; store recordings in Drive.
- **Full Postgres/MySQL support**: SQLite is load-bearing — the D1 dialect, the hand-written migration history and every FTS5 index in this roadmap are SQLite. Hosted SQLite-compatible providers (milestone 17, item 3) give self-hosters a managed database without rewriting the data layer; revisit a Postgres engine only if real demand appears after that.
- **Search, queue, cache, database services**: D1 + FTS5, Queues, Durable Objects are the ceiling. If a feature needs Elasticsearch, the feature changes, not the architecture.
- **Two-way external mail sync** (unchanged from milestone 6).
- **Gamification and LMS** (their `achievement`, `training`): ideas at best, off by default if ever.

## Sequencing

Shipped: **auto-agent** ([#28](https://github.com/midego1/kite/pull/28)) and the builtin **module platform (19, items 1–2)** ([#45](https://github.com/midego1/kite/pull/45)). **Subscriptions (18)** shipped next as Money Watch ([#50](https://github.com/midego1/kite/pull/50)), by decision ahead of the storage pair. The remaining build order is the approved storage pair in its existing order, **attachments-once → drive-storage**, then **RTL and i18n** (spec drafted), then the remaining modules above in order. Newsletters (20) follows the module platform (19); Kite Cloud plans (21) follow the provider seams (17) and module platform (19); Life Space (22) follows the widget contract; Connections (23) follows the module platform; the portfolio module (24) follows the dashboard and connectors. WebMCP (25) is a separate, optional Kite UI enhancement, gated on browser/spec maturity; it is not a dependency for connectors, apps, or server-side MCP. Each runs as one Factory Mission against a fresh spec in `docs/specs/`, written against the then-current `main` and taking the next free migration number. Dependencies: milestone 10 needs 7 (storage); 12 and 13 reuse 11 (boards) and each other lightly; 17 lands alongside whatever exists.

A mail-only install that never turns a module on keeps its current performance, bundle size and backup behavior — that constraint is part of every milestone's acceptance criteria.
