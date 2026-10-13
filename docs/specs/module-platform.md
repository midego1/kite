# Spec: module platform (switchable Calendar, Booking, Email templates and Mail import)

Status: Approved for a Factory Mission on `mission/module-platform`. Written against `main` at `eb873fa`. The next free migration number is 0062; take the next free number when you start if another branch lands first. Scope: Roadmap milestone 19 (modules). This spec supersedes the "extensions run as separate services" wording in milestone 19 and the matching line in the ROADMAP ideas list: modules are built into the Kite Worker and the Node server first, and sandboxed apps are signed bundles that run inside the user's own Kite later (§16). It also commits `docs/roadmap-complete-suite.md`, which is currently untracked on this branch.

## 1. Summary

Kite grows from a mail client into a suite. Every new area (calendar, booking, templates, import, later alerts) adds pages, API routes, assistant tools, MCP tools, webhook events, search results, composer controls and background work. Today each of those is wired by hand into a dozen places, and none of it can be turned off. This spec adds a small module platform:

- A **module** is a named feature area with a client-safe manifest (pages, navigation, UI commands, composer slots, record kinds, queue message types, cron tasks, labels) and a list of **capability descriptors**: JSON-only declarations of what the module offers (tools, search, record resolution, triage steps, actions, webhook events, lifecycle hooks, cron tasks, queue handlers, services).
- **Core calls a module through one function**, `invokeCapability(moduleId, name, input, ctx)`, with JSON input, a JSON call context and a JSON result. Core never hands a module `env`, a database handle, a binding, a `Request` or a function. The same contract can later cross a sandbox boundary unchanged.
- The primary admin (the owner) can **turn a module off** for the whole install, and **restrict a module per user**. Turning a module off hides it everywhere and makes its routes answer 404; it never deletes data, and turning it back on restores everything.
- **Core surfaces expand automatically.** The assistant, automatic reading, MCP, REST scopes, JMAP, webhooks, search, For you, Activity, the command palette, the composer, the queue consumers and the cron handlers read the registry instead of hard-coded lists, and contain no per-module code.
- **Four modules are extracted in this Mission:** Calendar, Booking (depends on Calendar), Email templates and Mail import. Mailbox export stays core and is always available.

Design principles:

1. **Off means absent, not broken.** A disabled module produces no links, no tools, no events, no background work and no errors. Its URLs answer 404, the same as a page that never existed.
2. **Data stays.** Disabling only gates access. Data hooks that protect integrity (for example the time zone change that freezes legacy recurring series) keep running, and paused work (an IMAP import) resumes when the module is turned back on.
3. **One narrow, serializable contract.** Capabilities are described as data and called with JSON. Builtin modules are trusted first-party code and reach their own tables directly inside their handlers, but nothing crosses the core/module boundary except JSON.
4. **No per-module wiring in core.** Core surface files, including `worker.ts`, `server/index.ts` and the Node scheduler, never import module code. A unit test enforces it.
5. **Nothing changes for existing installs.** The migration seeds all four modules as enabled, and a database without the new tables behaves as if every module is enabled.
6. **Builtin first.** Every module in this milestone has `runtime: "builtin"`. The contract is shaped so that `runtime: "sandboxed"` is an adapter, not a redesign.

Non-goals for this milestone: third-party or uploaded modules, a module marketplace, the sandbox runtime itself, per-mailbox module switches, moving delivery features (rules, spam, auto-reply) out of core, and the assistant running commands inside the user's tab (designed in §6.3, not built).

## 2. Core and modules

### 2.1 What stays core

Core is everything a mail server needs to be useful on its own. It cannot be turned off.

| Area | Why it stays core |
| --- | --- |
| Mail (inbox, folders, threads, compose, send, drafts, snooze, rules, spam) | The product. |
| Accounts, mailboxes, domains, sharing, API keys, MFA | Identity and access for everything else. |
| Assistant chat, automatic reading, For you, Activity | Shared surfaces that modules plug into. |
| Search, command palette, shortcuts, the composer | Shared surfaces that modules plug into. |
| Webhooks, MCP, REST `/api/v1`, JMAP | Shared surfaces that modules plug into. |
| **Mailbox export** (`/settings/export`, `GET /api/export/messages`, `src/lib/export/mbox.ts`) | A user's ability to take their mail out is a data-ownership guarantee that sits next to backups. It is always available, whatever the state of the Mail import module. |
| Auto-reply, operational alerts | Core for now (§2.3). |
| Contacts (as stored today, `contacts` upserted on delivery) | Used by the mail pipeline and automatic reading facts. There is no contacts page; `contact:contact` is reserved as a core record kind for when one is built. |
| Backups, migrations, admin settings, audit log | Install administration. |
| Drive and storage (when built) | Planned as core in [Drive and storage](drive-storage.md); attachments depend on it. |

Export and import share nothing that gating could hide by accident: separate pages (`/settings/export`, `/settings/import`), separate API prefixes (`/api/export`, `/api/import`) and separate libraries. They share two things, both handled in core: the "Mailbox" group in the Settings navigation (`src/components/settings/section-nav-utils.ts`), where Export stays a core item and Import becomes a module nav item, and the two legacy redirect pages `src/app/(dashboard)/import-export/page.tsx` and `src/app/(settings)/settings/import-export/page.tsx`, which redirect to `/settings/import` when Mail import is enabled for the viewer and to `/settings/export` otherwise (§10.1).

### 2.2 Modules in this milestone

| Module | Id | Depends on | Default | Owns |
| --- | --- | --- | --- | --- |
| Calendar | `calendar` | none | enabled | Pages `/calendar`; API `/api/calendar/*`; table `calendar_events`; calendar assistant and MCP tools; the `calendar_invite` suggestion kind and invite actions; the Events search section; `calendar.event.*` webhook events; `calendar_events_fts` |
| Booking | `booking` | `calendar` | enabled | Pages `/booking`, `/book/*`, `/c/*`; API `/api/booking/*`, `/api/public/booking*`; tables `booking_events`, `booking_appointments`; booking usernames; the `booking.appointment.created` webhook event; the `workingHours` service |
| Email templates | `templates` | none | enabled | API `/api/templates/*` (`route.ts` and `[id]/route.ts`); template rows in `messages` (`status = "template"`); the composer send-menu slot (Template submenu and New template dialog); record kind `templates:template`. No page, no queue, no cron. |
| Mail import | `import` | none | enabled | Page `/settings/import` and its Settings nav item; API `/api/import/*` (`messages`, `imap`, `imap/folders`, `jobs`, `jobs/[id]`); table `import_jobs`; queue message type `import.imap` (on `AGENT_QUEUE`); cron task `resumeStalledImports`; record kind `import:job`; the IMAP raw-socket client in `src/lib/import/imap.ts` |

Booking writes appointments into `calendar_events` and shows them in the calendar, so it cannot run without Calendar. The effective state of a module is: install-level enabled, and every dependency effectively enabled, and allowed for the user (§7).

### 2.3 Later modules

| Candidate | Size | Why later |
| --- | --- | --- |
| Operational alerts | M | Alerts are how an operator learns that backups or migrations are failing; making them switchable is a safety regression unless the Modules page warns clearly. It also needs the `*/5` cron branch and the dashboard banner moved behind the registry. Revisit once the platform has shipped. |
| Auto-reply / vacation | M | It runs inside delivery (`sendMailboxAutoReply` in `src/lib/email/inbound.ts`) and touches about 15 core files. Moving it needs a delivery hook in the registry first. |

Everything else in the inventory (rules, spam, folders, snooze, sharing, aliases, forwarding, branding, shared attachment links, pruning, Drive and mailbox export) stays core.

## 3. Manifest, capability descriptors and the call contract

New directory `src/lib/modules/`. Types go in `module-types.d.ts`, pure helpers in `*-utils.ts`, following the repository convention.

| File | Side | Contents |
| --- | --- | --- |
| `src/lib/modules/<id>/manifest.ts` | client-safe | `ModuleManifest`: identity, pages, nav, UI commands, composer slots, record kind labels, webhook event labels, scope labels, search section labels, queue message types, cron tasks. Plain data. |
| `src/lib/modules/<id>/capabilities.ts` | server, JSON only | `CapabilityDescriptor[]` and the module's prompt fragment. No functions; a test round-trips it through `JSON.stringify`. |
| `src/lib/modules/<id>/schemas.ts` | server | The zod schemas the descriptors' JSON Schemas are generated from. |
| `src/lib/modules/<id>/server.ts` | server-only | `handlers: Record<string, CapabilityHandler>`, one per descriptor that core can invoke. |
| `src/lib/modules/registry.ts` | client-safe | `MODULE_MANIFESTS` in a fixed order. |
| `src/lib/modules/capability-registry.ts` | server | All descriptor lists, indexed by module and surface. |
| `src/lib/modules/server-registry.ts` | server-only | Imports every `<id>/server.ts`. Imported only by `invoke.ts`. |
| `src/lib/modules/invoke.ts` | server-only | `invokeCapability`, the only path from core into module code. |
| `src/lib/modules/host.ts` | server-only | `ModuleHost`, the plain-function facade modules use to reach core services. |
| `src/lib/modules/background.ts` | server-only | `dispatchModuleQueueMessage` and `runModuleCronTasks` (§11.7). |
| `src/components/modules/client-registry.ts` | client | Lazy client pieces per module (§3.6). |

### 3.1 Client-safe manifest

`manifest.ts` must not import `@/db`, `@/lib/cloudflare`, `server-only` code, zod schemas or React components; both the browser bundle and the server read it.

```ts
export type ModuleId = "calendar" | "booking" | "templates" | "import";

export type ModuleManifest = {
	id: ModuleId;
	name: string; // "Calendar"
	description: string; // one sentence for the admin page
	runtime: "builtin"; // "sandboxed" is reserved for §16
	dependsOn: ModuleId[];
	defaultEnabled: boolean; // used only when module_settings has no row
	pages: { prefix: string; public?: boolean }[]; // "/calendar", "/book", "/settings/import"
	apiPrefixes: { prefix: string; public?: boolean }[]; // "/api/calendar", "/api/import"
	nav: ModuleNavItem[];
	commands: UiCommand[]; // §6
	composerSlots: ComposerSlotDeclaration[]; // §3.7
	recordKinds: { kind: RecordKind; label: string; unavailableLabel: string }[];
	webhookEvents: { value: string; label: string; hint: string }[];
	grants: { grant: string; label: string }[]; // "calendar.read", "calendar.write"
	mcpScopes: { scope: string; label: string; grants: string[]; mailboxBound: boolean }[];
	apiKeyScopes: { scope: string; label: string; grants: string[] }[]; // REST /api/v1, none today
	searchSections: { id: string; label: string }[]; // "events" -> "Events"
	messageStatuses: string[]; // message statuses the module owns: ["template"]
	queueMessageTypes: { kind: string; queue: "inbound" | "outbound" | "agent"; capability: string; metricClass: string }[];
	cronTasks: { name: string; schedule: "every_tick" | "*/5 * * * *" | "0 2 * * *"; capability: string }[];
	actionLabels: Record<string, string>; // agent action type -> Activity label
	reasonTexts: Record<string, string>; // skip reason -> plain words
	adminNotes?: string[]; // shown on the Modules page next to the toggle
};
```

`ModuleNavItem` is `{ id, label, href, icon, placement: "mailbox-selector" | "account-menu" | "module-tabs" | "settings-nav", group?, keywords?, order }`. `group` names the Settings navigation group (`"Mailbox"`) for `settings-nav` items. `icon` is a name resolved by the client registry, so the manifest stays data.

`queueMessageTypes` and `cronTasks` are in the manifest, not only in the descriptors, because `worker.ts`, `server/index.ts`, `server/runtime/scheduler.ts` and `worker-utils.ts` route on them and must stay cheap to import. Each entry names the `queue` or `cron` descriptor that handles it, and the registry test checks the two match.

### 3.2 Capability descriptors

Every capability is a JSON-only descriptor. Nothing in a descriptor is executable.

```ts
export type CapabilitySurface =
	| "assistant_tool" // offered to the chat assistant
	| "mcp_tool" // offered to MCP keys
	| "search" // a search provider for one section
	| "resolve_refs" // record ref resolver for the module's kinds
	| "suggestion_kind" // a kind of agent suggestion and its payload schema
	| "triage_step" // runs during automatic reading
	| "action" // execute and undo an agent action
	| "webhook_event" // an event the module emits through ModuleHost
	| "lifecycle" // receives a core lifecycle event
	| "cron" // a scheduled task
	| "queue" // a queue message type the module consumes
	| "jmap_capability"
	| "jmap_method"
	| "service"; // a function other modules call, such as workingHours

export type CapabilityDescriptor = {
	name: string; // unique within the module: "get_schedule", "search", "processImportJob"
	surfaces: CapabilitySurface[]; // non-empty; only assistant_tool and mcp_tool may be combined
	description: string; // tool description shown to the model, or admin text
	inputSchema: JsonSchemaObject; // JSON Schema (draft 2020-12, the subset z.toJSONSchema emits)
	outputSchema?: JsonSchemaObject;
	scopes?: string[]; // grants the caller must hold, all of them
	effect: "none" | "read" | "create" | "update" | "delete" | "send" | "external";
	mailboxBound?: boolean; // the input names a mailbox that ctx.mailboxIds must include
	timeoutMs?: number; // default 10,000 for builtin handlers
	// Surface details, all JSON:
	search?: { section: string };
	refs?: { kinds: RecordKind[] };
	suggestionKind?: { kind: string; label: string; reasonTemplate: string };
	triage?: { order: number };
	action?: { actionType: string; suggestionKind?: string; undoable: boolean; undoWindowMs?: number };
	event?: { value: string }; // webhook_event: inputSchema is the payload schema
	lifecycle?: { event: "user.created" | "user.time_zone_changed"; dataHook: boolean };
	cron?: { task: string }; // names the manifest cronTasks entry
	queue?: { kind: string }; // names the manifest queueMessageTypes entry
	jmap?: { urn?: string; capability?: JsonValue; method?: string };
};

export type ModuleCapabilities = {
	moduleId: ModuleId;
	promptFragment: string | null; // static text with {timeZone} and {today} placeholders
	descriptors: CapabilityDescriptor[];
};
```

Prompt fragments are static strings. Core fills the two placeholders from the call context; it never calls a module to build its prompt text.

`webhook_event` descriptors are declarations only. Core never invokes them; the module emits the event through `ModuleHost.emitWebhook`, and core validates the payload against the descriptor's `inputSchema`.

Queue and cron handlers may run longer than a request. Their descriptors set `timeoutMs` explicitly (the import job sets it above its own run budget, `RUN_TIME_BUDGET_MS`, and below `LEASE_MS`).

### 3.3 The call contract

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type CapabilityCallContext = {
	viewer: { userId: string; role: string; isPrimaryAdmin: boolean } | null; // role as stored on users.role
	requestId: string;
	locale: string; // "en-GB"
	timeZone: string; // the viewer's time zone, or the install default
	grants: string[]; // "calendar.read", "calendar.write"
	mailboxIds?: string[]; // mailboxes the caller may act on (MCP key mailboxes, the triage mailbox)
	trigger: "chat" | "auto_read" | "mcp" | "api" | "cron" | "queue" | "webhook" | "system";
};

export type CapabilityErrorCode =
	| "unknown_capability"
	| "module_disabled"
	| "forbidden"
	| "invalid_input"
	| "invalid_output"
	| "not_found"
	| "timeout"
	| "handler_error";

export type CapabilityResult =
	| { ok: true; output: JsonValue }
	| { ok: false; error: { code: CapabilityErrorCode; message: string; retryable?: boolean } };

export function invokeCapability(
	moduleId: ModuleId,
	name: string,
	input: JsonValue,
	ctx: CapabilityCallContext,
): Promise<CapabilityResult>;
```

`invokeCapability` (`src/lib/modules/invoke.ts`) runs these steps in order and never throws:

1. Look up the descriptor; a missing one answers `unknown_capability`.
2. Check module state: effectively enabled for `ctx.viewer`, or for the install when `viewer` is `null`. Lifecycle descriptors with `dataHook: true` skip this check. Otherwise `module_disabled`.
3. Check that `ctx.grants` contains every entry in `scopes`, and that a `mailboxBound` input names a mailbox in `ctx.mailboxIds`. Otherwise `forbidden`.
4. `assertJsonValue(input)` and `assertJsonValue(ctx)` (`src/lib/modules/json-utils.ts`): only `null`, booleans, finite numbers, strings, arrays and plain objects whose prototype is `Object.prototype` or `null`; no `undefined`, functions, symbols, `bigint`, `Date`, `Map`, `Set`, class instances or cycles; at most 32 levels deep and 1 MiB serialized. Otherwise `invalid_input`.
5. Validate `input` against the schema. Otherwise `invalid_input` with the first issue path in `message`.
6. Call the handler with a timeout (`timeoutMs`). A thrown error becomes `handler_error` with a generic message; the details go to the structured log, not to the caller, because tool results reach the model.
7. `assertJsonValue(output)` and validate it against `outputSchema` when present. Otherwise `invalid_output`.
8. Log module, capability, trigger, duration and result code.

Validation decision: **JSON Schema is the wire format and zod is the validator for builtin modules.** Each builtin schema is written once in zod in `schemas.ts`, and the descriptor's `inputSchema` is `z.toJSONSchema(schema)` (zod 4.4 is already a dependency). `invokeCapability` validates builtin calls with that same zod schema, so there is one source and no second validator in the Worker bundle. A unit test asserts that every descriptor's `inputSchema` equals `z.toJSONSchema` of its zod schema. Sandboxed apps (§16) ship JSON Schema only; that later mission adds a JSON Schema validator that runs on Workers without code generation (Ajv compiles with `new Function`, which Workers refuse unless the validators are precompiled), for example `@cfworker/json-schema` or Ajv standalone output.

Builtin handlers have the signature `(input: JsonValue, ctx: CapabilityCallContext) => Promise<JsonValue>`. Because builtin modules are trusted first-party code, a handler may call `getEnv()` and `getDb()` itself to read and write the module's own tables (`calendar_events`, `booking_events`, `booking_appointments`, `import_jobs`, template rows in `messages`). It reaches core services (sending, webhooks, other modules, record refs, mail reads and writes, audit) only through `ModuleHost`, so its call sites already look like the future RPC surface.

### 3.4 Grants

Grants are the scopes inside the contract. Each module declares its own (`calendar.read`, `calendar.write`, `booking.read`, `booking.write`, `templates.read`, `templates.write`, `import.run`). Core maps every trigger to a grant set before it invokes anything:

| Trigger | Grants |
| --- | --- |
| `chat`, `api` (session) | Every grant of every module enabled for the user. A user has full rights over their own calendar, booking pages, templates and imports. |
| `mcp` | The key's MCP scopes mapped through `mcpScopes[].grants` (`mcp:calendar-read` gives `calendar.read`; `mcp:calendar-write` gives both). |
| `auto_read` | Read grants of the modules enabled for the reviewer; write grants only for actions the autonomy level allows (none at Suggest only). |
| `cron`, `queue`, `system`, `webhook` | The module's own grants, with `viewer: null`. |

### 3.5 ModuleHost

`src/lib/modules/host.ts` exports `moduleHost`, an object of plain async functions that take `(ctx, ...json)` and return JSON. Every function applies the same permission rules as the user-facing path.

| Function | Does |
| --- | --- |
| `emitWebhook(ctx, moduleId, event, payload)` | Checks the event belongs to the module and the module is enabled, validates the payload against the descriptor, adds `ref`, and calls `dispatchWebhooks`. |
| `invoke(ctx, moduleId, name, input)` | Cross-module calls (Calendar asking Booking for `workingHours`); goes through `invokeCapability`, so a disabled target answers `module_disabled`. |
| `modules.isEnabledFor(ctx, userId, moduleId)` | Per-user state for background work that has no viewer (the import queue handler checks the job owner). |
| `resolveRefs(ctx, refs)` | The batch resolver in §5. |
| `mail.getMessage(ctx, messageId)` | A minimal JSON view of a message the viewer can read (`getMailboxAccessLevel`). |
| `mail.readAttachment(ctx, messageId, attachmentId, { maxBytes })` | Text or base64 content of one attachment, size-capped; used for ICS invites. |
| `mail.send(ctx, draft)` | The normal send path (`sendEmail`), from a mailbox the acting user may send from, so the user's limits, Sent copy, threading and audit apply. Used for invitations and RSVP replies. |
| `mail.importMessages(ctx, { userId, mailboxId, destination, messages })` | The existing import write path (`importMessagesToMailbox` in `src/lib/import/service.ts`, which parses, threads, stores attachments and upserts contacts through core). Raw MIME arrives as a string or byte array per message, inside the size caps the import routes already apply. |
| `users.getProfile(ctx, userId)` | Display name, email and time zone. |
| `audit(ctx, action, metadata)` | Writes an `audit_logs` row with `metadata.ref`. |

In this milestone, existing module code that calls `sendEmail` or `dispatchWebhooks` directly is rerouted through `moduleHost`. The import test (§19.1) refuses direct imports of `@/lib/email/send` and `@/lib/email/webhooks` from the module directories.

`mail.importMessages` is a pragmatic boundary for this Mission: `importMessagesToMailbox` stays where it is and keeps calling `@/lib/email/parse`, `@/lib/email/threading`, `@/lib/email/attachments` and `@/lib/contacts/service` internally, because it is the mail write path, not module logic. What becomes module-only is the job lifecycle, the IMAP client and the file upload parsing.

### 3.6 Client-side module pieces

`src/components/modules/client-registry.ts` maps each module id to:

- `icons`: a small static map of the `lucide-react` icons its nav items name. These render on every page, so they are eager.
- `load: () => import("@/components/modules/<id>/client")`: a lazy chunk exporting `suggestionCards` (For you and reader card renderers keyed by suggestion kind), `commandHandlers` (client handlers keyed by the `handler` name in `UiCommand.target`), `composerSlots` (§3.7, keyed by slot declaration id) and any dialogs those pieces open.

Core client surfaces (For you, the reader card slot, the palette, the composer) call `load()` only when they need a piece for a module enabled in `useModules()`. The mail-only bundle never pulls module UI eagerly. Calendar's invite card moves into `src/components/modules/calendar/client.tsx`; `template-menu.tsx`, `new-template-dialog.tsx` and `template-types.d.ts` move from `src/components/compose/` into `src/components/modules/templates/`.

### 3.7 Composer extension point

The composer has one slot in this Mission, the send menu (`src/components/compose/schedule-send-menu.tsx`, the chevron beside Send), which today mounts `TemplateMenu` and `NewTemplateDialog` directly. A module declares a slot entry in its manifest:

```ts
export type ComposerSlotDeclaration = {
	id: string; // "templates.send-menu"
	slot: "send-menu"; // more slots ("toolbar", "footer") can be added later
	order: number;
	label: string; // for tests and accessibility, "Template"
};

// Props the composer passes to a slot component (client side, first-party code):
export type ComposerSlotProps = {
	mailboxId: string | null;
	from: string;
	composer: {
		applyContent(content: { subject: string; html: string }): void; // today's onApplyTemplate
	};
};
```

`ScheduleSendMenu` renders a core `ComposerSlot` component for `slot: "send-menu"`. It lists the declarations of modules enabled in `useModules()`, sorted by `order`, loads each module's chunk with `load()` the first time the menu opens, and renders `composerSlots[id]` with `ComposerSlotProps`. A slot component may render menu items and its own dialog (the New template dialog, which is portalled). The separator above "Schedule" renders only when at least one slot entry rendered. With Templates off, the send menu shows only the schedule options, the composer makes no `/api/templates` request, and no template code is loaded. `compose-form.tsx` passes `composer.applyContent` instead of the `onApplyTemplate` prop, keeping today's behaviour (it sets the subject and the HTML body).

The composer API is a narrow object of callbacks, not JSON. That is acceptable because slot components are first-party client code running in the user's own tab; the serializable rule applies to server capabilities. A sandboxed app would contribute UI through commands, not composer components (§16).

## 4. Registry API

`src/lib/modules/state.ts` (server) and `src/lib/modules/state-utils.ts` (pure):

| Function | Returns | Notes |
| --- | --- | --- |
| `getInstallModuleState(env)` | `Map<ModuleId, boolean>` | Reads `module_settings`. Missing table or missing row means `defaultEnabled`. Memoized per request with React `cache` and in an isolate cache for 30 seconds; writes clear the isolate cache. |
| `getUserModuleAccess(env, userId)` | `Map<ModuleId, boolean>` | Reads `user_module_access`. No row means allowed. The primary admin is always allowed. |
| `effectiveModules(install, access, manifests)` | `Set<ModuleId>` | Pure. Applies dependencies transitively, so booking is off whenever calendar is off. |
| `isModuleEnabled(env, id)` | `boolean` | Install-level and dependencies only. Used when there is no viewer (cron, queue, webhook retries). |
| `isModuleEnabledFor(env, viewer, id)` | `boolean` | Install-level, dependencies and per-user access. |
| `listEnabledModules(env, viewer)` | `ModuleId[]` | Feeds `/api/auth/me`. |
| `listCapabilities(surface, enabled)` | `{ moduleId, descriptor }[]` | Pure, from `capability-registry.ts`. Core adapters build their surface from it. |
| `moduleOwnedMessageStatuses()` | `Map<string, ModuleId>` | Pure, from the manifests' `messageStatuses`. |
| `buildCallContext(input)` | `CapabilityCallContext` | Builds the context and grant set for a trigger (§3.4). |
| `invokeCapability(...)` | `CapabilityResult` | §3.3. |
| `requireModule(env, request, id)` | `NextResponse \| null` | API guard core (§10.2). |
| `requireModulePage(id)` | `void` (calls `notFound()`) | Page guard (§10.1). |

The isolate cache means a toggle may take up to 30 seconds to reach other isolates. The admin page says so. The isolate that handled the write sees the change at once, and the next `/api/auth/me` in that tab reflects it.

`isModuleEnabled` catches the D1 and better-sqlite3 "no such table" errors and treats them as all-enabled, which keeps a deployed release working before migration 0062 is applied. It reads no new column on existing tables, which matches the rule in CLAUDE.md for code that runs while the schema is behind.

The client reads `modules: ModuleId[]` from `GET /api/auth/me` (`src/app/api/auth/me/route.ts`) and exposes it through a `useModules()` hook in `src/components/modules/modules-context.tsx`. The client list is a display hint only; every server path checks again.

## 5. Record refs

A record ref names one record anywhere in Kite: `{ kind: RecordKind; id: string }`. Kinds are `<namespace>:<type>`.

| Kind | Owner | Id | Resolves to |
| --- | --- | --- | --- |
| `mail:message` | core | `messages.id` | `/inbox?message=<id>` (or the folder it is in), subject |
| `mail:thread` | core | thread id | the thread in conversation view, subject |
| `mail:mailbox` | core | `mailboxes.id` | the mailbox, address |
| `user:user` | core | `users.id` | the account page for admins, display name |
| `contact:contact` | core, reserved | `contacts.id` | not resolvable until a contacts page exists |
| `calendar:event` | calendar | `calendar_events.id` | `/calendar?date=<day>&event=<id>`, title |
| `booking:event_type` | booking | `booking_events.id` | `/booking?event=<id>`, name |
| `booking:appointment` | booking | `calendar_events.id` of an appointment | the calendar event, title, with a "Booked" label |
| `templates:template` | templates | `messages.id` of a row with `status = "template"` | the template title, with `href: null` (there is no templates page) |
| `import:job` | import | `import_jobs.id` | `/settings/import`, the job label and status |

`booking_events` rows are event types (name, duration, working hours), not appointments, which is why the kind is `booking:event_type`. An appointment is a `calendar_events` row that a public booking created; the new `booking_appointments` table (§8) records which rows those are.

`resolveRecordRefs(ctx, refs)` in `src/lib/modules/record-refs.ts` resolves core kinds itself and, for module kinds, groups refs by owner and calls `invokeCapability(moduleId, "resolveRefs", { refs }, ctx)` once per module per batch. The output schema is `{ results: [{ kind, id, href: string | null, label } | { kind, id, unavailable: true }] }`. Core turns a failed call, a `module_disabled` answer, a missing record or an unavailable result into `{ unavailable: true, label }` with the manifest's `unavailableLabel` ("Calendar event", "Booking", "Template", "Import"). The UI renders an unavailable ref, or one with `href: null`, as plain text, never as a link, and never leaks a title the viewer cannot see. Every `href` is checked by `isSameOriginPath` in `record-ref-utils.ts` (must start with `/`, not `//`, no scheme) so a module bug cannot produce an external link.

Refs are computed from columns that already exist: `agent_suggestions.message_id` gives `mail:message`, a calendar-invite suggestion's payload event id gives `calendar:event`, and `agent_actions` targets give their kind. `audit_logs` gets refs inside its existing metadata JSON (`metadata.ref`), so no column changes. Webhook payloads for module events carry `ref` (§11.5).

## 6. UI commands

### 6.1 Registry

Every module registers its UI commands in its manifest; core registers its own in `src/lib/modules/core-commands.ts`. One type covers both:

```ts
export type UiCommand = {
	id: string; // "calendar.open", "mail.compose"
	moduleId: ModuleId | "core";
	label: string;
	description: string;
	keywords?: string[];
	group: string; // palette group: "Go to", "Create", "Mail"
	params?: JsonSchemaObject; // parameters the command accepts
	target:
		| { type: "route"; href: string } // href template using params, e.g. "/calendar?date={date}"
		| {
				type: "client";
				action: "open_view" | "apply_filter" | "open_dialog" | "fill_form" | "invoke";
				handler: string; // name in the module's client-registry commandHandlers
		  };
	effect: "navigate" | "read" | "fill" | "create" | "update" | "delete";
	shortcut?: string;
};
```

A route target's `href` is a template. Core fills `{name}` placeholders from the params after validating them against `params`, URL-encodes each value, and checks the result with `isSameOriginPath`. A client target names a handler that a mounted component registers with `useCommandHandler(id, handler)` or that the module's lazy client chunk exports (§3.6); the handler runs in the tab with the user's own session, through the same API routes as a click. The palette lists a client command only while a handler for it is available, so a command that needs an open composer appears only while one is open.

The built-in commands in `src/components/shortcuts/shortcuts-context.tsx` move to `core-commands.ts`, keeping their ids, labels and shortcuts; the ones that open the composer or run a client action become `target: { type: "client", ... }` handled by core's own client handlers. The command palette (`src/components/shortcuts/command-palette.tsx`) lists core commands plus the commands of every module in `useModules()`. Shortcut bindings follow the same filter, so a disabled module's shortcut does nothing.

### 6.2 What this Mission builds

- The registry, the `UiCommand` type with every field above, and the palette fed from it.
- Navigation commands (route targets, effect `navigate`):
  - core: Inbox, Sent, Drafts, Starred, Snoozed, Archived, Spam, Trash, For you, Activity, Settings, and Export (`mail.export`, `/settings/export`, always available);
  - calendar: `calendar.open`, `calendar.go_to_date` (`params: { date }`);
  - booking: `booking.open`, `booking.open_event_type` (`params: { id }`);
  - import: `import.open` (`/settings/import`).
  - Templates has no navigation command, because there is no templates page.
- The existing client commands, re-expressed as client targets (for example `mail.compose`, `open_dialog`).
- The chat tool `open_page`. Its input schema is built per request: `{ command: { enum: [...] }, params?: object }`, where the enum lists only the ids of `navigate` commands with route targets that are enabled for the user. It returns `{ href, label }`, which the chat renders as a link the user clicks. It cannot name an arbitrary URL. With Calendar off, no `calendar.*` id appears in the offered tool, which the fake-model e2e asserts from the recorded request.
- `open_page` is never offered to automatic reading, which stays tool-less.

### 6.3 Assistant actions in the tab (designed, not built)

Later, the assistant may switch pages, run actions and fill forms in the user's open tab, with control as granular as the user wants. Design:

- **Per-tab client bridge.** The chat panel in the open tab receives a proposed command (`{ commandId, params }`) as a part on the existing chat stream. The client looks the command up in the registry, validates the params against `params`, and runs it through the same route or client handler a palette click uses, with the user's own session and permissions. The server never drives the browser.
- **Forms.** A `fill_form` command fills fields and stops. It does not submit unless the policy allows the follow-up `create` or `update` command, which is a separate proposed command with its own effect. The first planned example is `templates.insert` (`target: { type: "client", action: "fill_form", handler: "insertTemplate" }`, `effect: "fill"`, `params: { templateId }`), registered by the Templates composer slot while a composer is open; it fills subject and body and never sends.
- **Confirmation policy.** Each command declares its `effect`. The user sets, per effect level (`navigate`, `read`, `fill`, `create`, `update`) and optionally per command id, whether the assistant may act directly or must ask first. Defaults: `navigate`, `read` and `fill` act directly; `create` and `update` ask. `delete` always asks and is not configurable for now. When it asks, the panel shows the effect in words ("Create event *Team sync*, Tue 14:00") with Confirm and Cancel; a batch shows each effect.
- **Storage.** The policy is stored per user, for example in a JSON column on the user's settings, chosen by that later mission. It applies only to chat requests the user makes in that tab, never to automatic reading, MCP or API calls.

Fields this Mission adds now so the later mission needs no breaking change: `effect` (all six values), `params`, `description`, and `target.client` with every `action` value. The later mission adds the stream part, the client bridge, `templates.insert` and the policy store.

## 7. Permissions

These are decisions, not options:

- **Only the primary admin (owner) can turn modules on or off and change per-user module access.** Other admins never see the Modules page: `src/components/admin-route-utils.ts` adds `/modules` to `primaryOnlyPrefixes`, so `requirePrimary` redirects them to `/admin` as it does for the other owner-only pages, and the admin navigation hides the entry for them.
- `GET` and `PUT /api/admin/modules` (`src/app/api/admin/modules/route.ts`) use `requireSessionAdmin(env, request, isPrimaryAdmin)`: 401 without a session, 403 for anyone else.
- Per-user access is a "Modules" section on `src/app/(admin)/accounts/[id]/permissions/page.tsx`, rendered only for the owner, saved through `PUT /api/admin/accounts/[id]/modules` (owner-only). The owner's own row cannot be restricted.
- A user restricted from a module sees exactly what everyone sees when the module is off for the install. For Booking that includes their own public booking pages, which answer 404 while the host is restricted. For Mail import it includes their queued jobs, which pause (§15).
- Turning a module on when its dependency is off is refused with 409 `MODULE_DEPENDENCY`. Turning a dependency off does not rewrite the dependent's stored flag; the admin page shows Booking as "Off because Calendar is off", and turning Calendar back on restores Booking as it was.
- The Modules page shows each manifest's `adminNotes`. Mail import's note: "Turning this off pauses running imports. They keep their saved source credentials until they finish or are cancelled, and resume within about five minutes of turning it back on."
- Every change writes an `audit_logs` row (`module.enabled`, `module.disabled`, `module.user_access`) with `metadata.ref` naming the user for per-user changes.

## 8. Data model and migration 0062

New schema file `src/db/schema/modules.ts`, imported by `drizzle.config.ts` and merged into the Drizzle `schema` object in `src/db/index.ts`, as `agent-auto-read.ts` is. `calendar_events` itself is not altered: adding a column there would make every existing `select()` from `calendarEvents` fail on a database that has not applied 0062, which breaks the deploy-before-migrate rule. Templates and import need no schema change: template rows stay in `messages`, and `import_jobs` (`src/db/schema/import-jobs.ts`) stays as it is.

`drizzle/migrations/0062_add_module_platform.sql`, hand-written in the generated style:

```sql
CREATE TABLE `module_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_settings_module_id_unique` ON `module_settings` (`module_id`);
--> statement-breakpoint
CREATE TABLE `user_module_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`module_id` text NOT NULL,
	`allowed` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_module_access_user_module_unique` ON `user_module_access` (`user_id`,`module_id`);
--> statement-breakpoint
CREATE TABLE `booking_appointments` (
	`calendar_event_id` text PRIMARY KEY NOT NULL,
	`booking_event_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`calendar_event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`booking_event_id`) REFERENCES `booking_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `booking_appointments_booking_event_idx` ON `booking_appointments` (`booking_event_id`);
--> statement-breakpoint
INSERT INTO `module_settings` (`id`, `module_id`, `enabled`, `updated_at`) VALUES ('calendar', 'calendar', 1, unixepoch()), ('booking', 'booking', 1, unixepoch()), ('templates', 'templates', 1, unixepoch()), ('import', 'import', 1, unixepoch());
--> statement-breakpoint
CREATE VIRTUAL TABLE `calendar_events_fts` USING fts5(title, description, location, attendees, content='calendar_events', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_ai` AFTER INSERT ON `calendar_events` BEGIN
	INSERT INTO calendar_events_fts(rowid, title, description, location, attendees) VALUES (new.rowid, new.title, new.description, new.location, new.attendees);
END;
--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO calendar_events_fts(calendar_events_fts, rowid, title, description, location, attendees) VALUES ('delete', old.rowid, old.title, old.description, old.location, old.attendees);
END;
--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_au` AFTER UPDATE OF `title`, `description`, `location`, `attendees` ON `calendar_events` BEGIN
	INSERT INTO calendar_events_fts(calendar_events_fts, rowid, title, description, location, attendees) VALUES ('delete', old.rowid, old.title, old.description, old.location, old.attendees);
	INSERT INTO calendar_events_fts(rowid, title, description, location, attendees) VALUES (new.rowid, new.title, new.description, new.location, new.attendees);
END;
--> statement-breakpoint
INSERT INTO `calendar_events_fts`(`calendar_events_fts`) VALUES ('rebuild');
```

Copy the exact trigger shape and tokenizer from `drizzle/migrations/0030_add_message_search_index.sql` so the two indexes behave the same; the block above shows intent. The journal entry in `drizzle/migrations/meta/_journal.json` is `{ "idx": 65, "version": "6", "when": 1788851220028, "tag": "0062_add_module_platform", "breakpoints": true }`. `splitSqlStatements` already keeps trigger bodies whole, and `npm run db:bundle` picks the file up.

Decisions:

- Two dedicated tables, not `app_settings` keys. Module state is read on almost every request and per-user access needs a join key; a JSON blob in `app_settings` would need parsing and could not hold per-user rows cleanly.
- `module_settings.id` equals `module_id` for the seeded rows, so restore and upsert are simple. The unique index stays for safety.
- Missing rows mean `defaultEnabled`. A future module that ships with `defaultEnabled: false` needs no migration seed.
- `booking_appointments` is owned by the booking module (approved). `createBookedCalendarEvents` (`src/lib/booking/create.ts`) inserts one row per host event it creates, in the same batch. Existing appointments are not backfilled (approved), because nothing on a `calendar_events` row reliably says it came from a booking; they stay plain calendar events. If the table is missing (before 0062), the insert is skipped with a logged warning and the booking still succeeds.
- Search scope: the calendar `search` handler queries `calendar_events_fts` joined to `calendar_events` with `user_id = ctx.viewer.userId`, using `buildFtsMatch` from `src/lib/search/query-utils.ts` on the free-text terms only. Gmail-style operators (`from:`, `has:`) are ignored for events. Before 0062 the handler returns no items.

## 9. Backups

Update in the same change, per AGENTS.md:

| File | Change |
| --- | --- |
| `src/lib/backups/export.ts` `BACKUP_TABLES` | Add `module_settings` after `app_settings`; add `user_module_access` after `users`; move `booking_events` above `calendar_events` (it references only `users` and `domains`), then add `booking_appointments` after `calendar_events`. Foreign-key order then holds for restore and reverse delete. |
| `src/lib/backups/export.ts` `INTERNAL_TABLE_PATTERNS` | Add `calendar_events_fts%`. The FTS shadow tables are derived; triggers repopulate them on restore. |
| `src/lib/backups/table-groups.ts` | `module_settings` in `system`; `user_module_access` and `booking_appointments` in `accounts` (next to `calendar_events` and `booking_events`). No new group. |
| `src/lib/backups/types.d.ts` `DatabaseBackupTable` | Add the three table names. |

Templates and import add no tables, and their existing tables stay where they are, confirmed against the code:

- Template rows are `messages` rows with `status = "template"`, so they are backed up with `messages` in the `mail` group whether the module is on or off.
- `email_templates` stays in `BACKUP_TABLES` and in the `accounts` group. No application code reads or writes it today (only the three backup lists name it); dropping it is out of scope.
- `import_jobs` stays in `INTERNAL_TABLES` (not backed up), because jobs are transient, hold the source server's sealed password while active, and point at queue messages.

None of the new tables is required for a restore. A backup taken before 0062 restores into a database after 0062 with the three tables empty, which means every module enabled, every user allowed, and no appointment links; that is the same state as an upgraded install. A backup taken after 0062 restores into a database after 0062 with the module state as it was. Restore runs against a migrated database, so the FTS triggers fire on the deleted and restored `calendar_events` rows and the index stays complete, exactly as `messages_fts` does today; the backup code has no explicit rebuild step and needs none.

`wrangler d1 export` already fails on this database because of `messages_fts`; a second virtual table changes nothing. The app's JSON backup is unaffected.

## 10. Gating

### 10.1 Pages

Decision: gate pages in **server layouts**, not in middleware or proxy.

- vinext 1.1.0 supports `not-found.tsx` boundaries and `notFound()` from Server Components and route handlers. Next 16 renamed middleware to proxy and warns that proxy code should not rely on shared modules or globals, which is exactly what module state needs (D1 and an isolate cache), and proxy behaviour would have to be proven on both runtimes. A server layout runs inside the normal request with `getEnv()` and `cookies()`, as `src/app/(auth)/login/page.tsx` already does.
- `src/app/(calendar)/layout.tsx` is a client component today. It is renamed to `src/app/(calendar)/calendar-shell.tsx` (still `"use client"`, same content, exported as `CalendarShell`). A new server `src/app/(calendar)/layout.tsx` calls `await requireModulePage("calendar")` and renders `<CalendarShell>{children}</CalendarShell>`. It sets `export const dynamic = "force-dynamic"`.
- `src/app/(calendar)/booking/layout.tsx` (new, server) calls `await requireModulePage("booking")`. Because it sits inside the calendar group, Booking is also hidden when Calendar is off.
- `src/app/book/[userId]/layout.tsx` and `src/app/c/[username]/layout.tsx` (new, server) call `await requirePublicModulePage("booking", host)`, which resolves the host user from the segment and checks install state plus the host's per-user access. Visitors have no session, so only the host matters.
- `src/app/(settings)/settings/import/layout.tsx` (new, server) calls `await requireModulePage("import")`. The settings layout (`DashboardSectionShell`) stays as it is; `/settings/export` has no module layout and is never gated.
- The legacy redirect pages `src/app/(dashboard)/import-export/page.tsx` and `src/app/(settings)/settings/import-export/page.tsx` become async server components that redirect to `/settings/import` when `isModuleEnabledFor(viewer, "import")` is true and to `/settings/export` otherwise (signed-out visitors go to `/settings/import` only when Import is on for the install, then the existing auth redirect applies).
- Templates has no page.
- `requireModulePage` order: install-level off (or a dependency off) calls `notFound()` for everyone, signed in or not. When the module is on and there is no session, it returns and the existing client `AuthGuard` redirects to login as today. With a session, per-user access off calls `notFound()`.
- New `src/app/not-found.tsx` renders a plain "Page not found" card with a link to the inbox, using `blue-*` classes so it works in Kite, Classic and dark mode. Today an unknown URL falls through to the framework default.
- `requireModulePage` is memoized per request with React `cache`, as `src/app/(dashboard)/home-server-utils.ts` does, so nested layouts do not query twice.

Module pages and their own API routes are the module's UI, not core surfaces; they keep importing `src/lib/calendar`, `src/lib/booking` and `src/lib/import` directly.

### 10.2 API routes

`withModule(id, handler)` in `src/lib/modules/route-guard.ts` wraps each exported method of every route under a module's `apiPrefixes`:

1. Install-level off (or a dependency off): 404 `{ error: "Not found" }` before authentication, for every caller.
2. Otherwise the handler's own authentication runs first, so a signed-out request still gets 401 and a non-admin still gets 403 where it does today (the auth checks in `e2e/13-security.spec.ts` stay valid).
3. After authentication, per-user access off: 404.

Because step 3 must run after the handler authenticates, `withModule` passes a `checkUser(user)` helper into the handler context, and the route calls it right after authenticating. That is `requireSessionUser` in the calendar, booking and templates routes, and `getCurrentUser` in the import routes (`src/app/api/import/jobs/route.ts` and its siblings use it with their own 401). The unit test `tests/module-route-guard.test.mjs` reads every `route.ts` under each manifest's `apiPrefixes` and fails if an exported method is not wrapped by `withModule` or if a session route never calls `checkUser`. It follows the text-scanning style of `tests/route-auth.test.mjs`.

Public booking routes (`/api/public/booking*`) check install state and the host's access, and keep their current 400 and 404 answers when the module is on, so `e2e/support/public-routes.ts` does not change.

`/api/export/messages` is not under any module prefix and is never wrapped.

`scripts/docs-generate.mjs` (`analyseHandler`) only recognises `requireScope` and `authenticateAdminApiKey`. No module route is part of the documented `/api/v1` surface in this milestone, so it needs no change; teach it `withModule` when the first module adds a `/api/v1` route.

### 10.3 Every surface

Calendar and Booking:

| Surface | Where | Calendar off | Booking off |
| --- | --- | --- | --- |
| Pages | §10.1 | `/calendar`, `/booking` 404 | `/booking`, `/book/*`, `/c/*` 404 |
| Session API | §10.2 | `/api/calendar/*`, `/api/booking/*` 404 | `/api/booking/*` 404 |
| Public API | §10.2 | `/api/public/booking*` 404 | same |
| Navigation | nav registry: `src/components/mailbox-selector.tsx` Calendar link (about lines 305 to 310), account menu, calendar layout tabs | Calendar link and tabs hidden | Booking tab and account menu link hidden |
| Palette and shortcuts | §6 | calendar commands hidden | booking commands hidden |
| Assistant tools and prompt | §11.1 | calendar tools, calendar prompt fragment and `calendar.*` ids in `open_page` absent | booking ids in `open_page` absent |
| MCP tools | §11.3 | calendar tools not listed; a call answers "unknown tool" | none today |
| MCP scopes | `MCP_SCOPES` in `src/lib/mcp/auth.ts` becomes core plus every module's `mcpScopes`, enabled or not | keys with `mcp:calendar-*` still authenticate; their calendar tools are absent | none today |
| API key creation | `src/lib/api/scopes.ts` and the MCP key form | a new key asking for `mcp:calendar-*` gets 400 `MODULE_DISABLED` | none today |
| REST `/api/v1` | no module routes today | none | none |
| JMAP | §11.4 | calendar declares none | booking declares none |
| Webhooks | §11.5 | `calendar.event.*` not emitted; new subscriptions refused | `booking.appointment.created` not emitted; refused |
| Automatic reading | §11.2 | calendar triage step skipped with reason `module_disabled`; other steps run | `workingHours` answers `module_disabled`; Calendar uses its default |
| For you and badges | `listSuggestions` (`src/lib/agent/auto-read/suggestion-api.ts`) | `calendar_invite` suggestions and their counts hidden | no change |
| Activity | `src/components/agent/agent-activity-utils.ts` | calendar actions shown with neutral labels via record refs; Undo refused with `module_disabled` | appointment refs unavailable |
| Search | §11.6 | Events section absent | no change |
| Record refs | §5 | `calendar:event` unavailable | `booking:*` unavailable |
| Lifecycle | §11.7 | `user.time_zone_changed` data hook still runs | `user.created` hook skipped |

Email templates and Mail import:

| Surface | Where | Templates off | Import off |
| --- | --- | --- | --- |
| Pages | §10.1 | none exist | `/settings/import` 404; legacy `/import-export` and `/settings/import-export` redirect to `/settings/export` |
| Session API | §10.2 | `/api/templates`, `/api/templates/[id]` 404 | `/api/import/*` 404 |
| Navigation | nav registry, `settings-nav` placement in `src/components/settings/section-nav-utils.ts` | none | "Import" hidden from the Settings "Mailbox" group; "Export" stays |
| Composer | §3.7 | send menu shows only schedule options; no `/api/templates` request; no template code loaded | no change |
| Message lists | `src/app/api/messages/route.ts` | rows with a module-owned status (`template`) are never listed; `?status=template` returns an empty list | no change |
| Palette and shortcuts | §6 | none today | `import.open` hidden; `mail.export` stays |
| Queue | §11.7 | none | `import.imap` messages acked and skipped with `module_disabled`; the job row is left untouched |
| Cron | §11.7 | none | `resumeStalledImports` does not run |
| Record refs | §5 | `templates:template` unavailable | `import:job` unavailable |
| Assistant, MCP, JMAP, webhooks, search | §11 | none exist today, none added | none exist today, none added |
| Export | core | unaffected | unaffected: `/settings/export` and `GET /api/export/messages` keep working |

`mailboxBound: true` on a module MCP scope replaces the `startsWith("mcp:calendar")` style checks that decide whether a scope needs `mcp_key_mailboxes` rows. Calendar scopes are `mailboxBound: false`, as today.

The message list rule is generic, not template-specific: `src/app/api/messages/route.ts` already excludes `status = "template"` unless that status is requested ("Composer templates are stored as messages but never listed"). It becomes: exclude every status in `moduleOwnedMessageStatuses()`, and when the request asks for an owned status, return rows only if the owning module is enabled for the viewer.

## 11. Core surfaces that expand

Every adapter below lives in core, reads descriptors through `listCapabilities` or manifests through `MODULE_MANIFESTS`, builds a context with `buildCallContext`, and calls `invokeCapability`. None imports module code.

### 11.1 Assistant chat

`src/lib/agent/chat.ts` builds AI SDK tools from the `assistant_tool` descriptors of modules enabled for the user: `tool({ description, inputSchema: jsonSchema(descriptor.inputSchema), execute })`, where `jsonSchema` comes from the `ai` package and `execute` calls `invokeCapability(moduleId, name, input, ctx)` with `trigger: "chat"`. A successful call returns `output` to the model; a failed one returns `{ error: message }`, as today's calendar tools do. The core email tools and `open_page` are added as before. Calendar tools and their grants follow only the Calendar module state and the user's module access, as on `main`: a mailbox's `capabilities.calendar` flag is the automatic-reading switch only (§11.2), so a shared mailbox with that flag off still gets the calendar tools in chat while Calendar is on for the user.

The system prompt (`agentSystemPrompt`, `src/lib/agent/model.ts`) is the core prompt plus the `promptFragment` of each enabled module, in registry order, with `{timeZone}` and `{today}` filled from the context.

Templates and import offer no assistant or MCP tools today, and this Mission adds none. The "template" mentions under `src/lib/agent/auto-read/` are prompt wording, not the feature.

### 11.2 Automatic reading

`processAgentTriageJob` (`src/lib/agent/auto-read/process.ts`) keeps its deterministic facts, the one tool-less model call, spend and caps in core. After the model answer, it runs the `triage_step` descriptors of modules enabled for the reviewer, in `triage.order`, each through `invokeCapability` with `trigger: "auto_read"` and input:

```json
{
	"message": { "id": "...", "mailboxId": "...", "from": "...", "subject": "...", "receivedAt": "..." },
	"facts": { "authPassed": true, "bulk": false, "knownContact": true, "phishing": [] },
	"attachments": [{ "id": "...", "contentType": "text/calendar", "filename": "invite.ics", "size": 2048 }],
	"model": { "...": "the validated triage answer, or null" }
}
```

The step returns `{ suggestions: [{ kind, payload, reason }], skipped?: reasonCode }`. Core validates every suggestion: the kind must be a `suggestion_kind` the same module declares, the payload must match that descriptor's `inputSchema`, at most three per step, and the message id is core's, not the module's. Then core inserts `agent_suggestions` rows as today. The calendar step reads the ICS through `moduleHost.mail.readAttachment`, parses it, checks availability and proposes slots; it asks Booking for working hours with `moduleHost.invoke(ctx, "booking", "workingHours", { userId })` and falls back to Monday to Friday, 09:00 to 17:00 in the user's time zone when that answers `module_disabled` or `null`.

When Calendar is off, core skips the step with reason `module_disabled`, which `reasonText` shows as "Calendar is turned off" (from the manifest `reasonTexts`). This sits alongside the existing `capability_calendar_off` reason, which still means the mailbox's calendar capability is off.

Actions: `ACTION_REGISTRY` (`src/lib/agent/auto-read/actions-utils.ts`) gains entries from `action` descriptors, keyed by `action.actionType`. The descriptors reuse the action type strings already stored in `agent_actions`, so old rows still resolve. `execute.ts` keeps write-before-effect: it inserts the `pending` row, then calls `invokeCapability(moduleId, name, { op: "execute", actionId, suggestion, input }, ctx)`, then marks the row `applied` or `failed`. The handler returns `{ result, inverse }`; core stores the inverse and passes it back on `{ op: "undo", actionId, inverse }`. Handlers must be idempotent by `actionId`, because stale pending rows are retried. `AgentActionType` widens to the core types plus `string` for module types, checked at runtime against the registry. While the module is off, execute and undo answer `module_disabled`, shown as blocked; undo works again once the module is on and the 7-day window has not passed.

### 11.3 MCP and API keys

`src/lib/mcp/server.ts` registers one tool per `mcp_tool` descriptor of modules enabled for the key's user and allowed by its scopes. The MCP SDK's `registerTool` takes a zod schema; the adapter gets it from `capabilityInputSchema(moduleId, name)` in `invoke.ts`, which for builtin modules is the module's own zod schema and, for sandboxed apps later, is converted from JSON Schema. Validation still happens inside `invokeCapability`, so the SDK check is a second layer. The handler calls `invokeCapability` with `trigger: "mcp"` and the key's mailboxes in `ctx.mailboxIds`.

Scope lists stay registry-wide so that turning a module off and on never invalidates keys. The key creation forms list only enabled modules' scopes.

### 11.4 JMAP

`handleJmapRequest` builds the session object and dispatch table per request from core plus enabled modules' `jmap_capability` and `jmap_method` descriptors. A module method call becomes `invokeCapability(moduleId, name, { args, accountId }, { trigger: "api", ... })` and its output is the JMAP response arguments. None of the four modules declares JMAP capabilities in this milestone (JMAP Calendars is a later Roadmap item). A unit test registers a test-only module with one capability and one method, and checks that the session lists it and that the method answers `unknownMethod` when the module is off.

### 11.5 Webhooks

- The four hand-kept event lists (`WEBHOOK_EVENTS` in `src/app/(admin)/webhooks/utils.ts`, the validator enums in `src/lib/validators.ts`, the `WebhookEvent` type and the dispatcher) become one list: core events plus every module's `webhookEvents`. The zod array limit `.max(3)` becomes the length of that list.
- New events, emitted by the modules through `moduleHost.emitWebhook`: `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted` (from `/api/calendar` writes, tool calls and invite actions), and `booking.appointment.created` (from `createBookedCalendarEvents`, once per booking, listing every host event).
- Templates and import emit no webhook events today, and this Mission adds none. Imported messages do not fire `message.inbound` today either (the import path does not call `dispatchWebhooks`); that stays.
- Payloads follow the existing envelope and add `ref` (for example `{ "kind": "calendar:event", "id": "..." }`) and a minimal record: id, title, start, end, time zone, and for bookings the event type id and the booker's name and email. Each event's payload schema is its descriptor's `inputSchema`.
- Creating or updating a webhook with a disabled module's event returns 400 `MODULE_DISABLED`. Existing subscriptions keep the event; nothing is emitted while the module is off, and pending retries for those events are dropped with a `module_disabled` note on the delivery row.
- First attempts go through the same inline `dispatchWebhooks` path as message events, with its existing timeout and retry queue (accepted default).
- The user webhook URL check (`isPublicHttpUrl`) refuses loopback, so e2e checks the event list and refusal through the API, not by receiving a delivery.

### 11.6 Search

- New `GET /api/search?q=&limit=5` (`src/app/api/search/route.ts`, session only) calls `invokeCapability(moduleId, "search", { query, limit }, ctx)` for every `search` descriptor of the modules enabled for the viewer, in parallel, and returns `{ sections: [{ id: "events", label: "Events", items: [{ ref, label, sublabel, href }] }] }`. A failed provider drops its section and is logged; the others still answer. Mail results stay on the existing message list path; this route returns module sections only.
- `MailSearchInput` (`src/components/mail-search/mail-search-input.tsx`) shows a dropdown below the input while typing (debounced 200 ms) with one block per section. Enter still runs the mail search. Choosing an event opens `/calendar?date=<day>&event=<id>`; the calendar page learns the `event` parameter and opens the event. `PageSearchInput` is unchanged.

### 11.7 Lifecycle, cron and queue

**Lifecycle.** Core emits lifecycle events as JSON: `{ "type": "user.created", "userId": "..." }` after account creation commits (`src/app/api/accounts/create.ts`, `src/app/api/auth/register/route.ts`), and `{ "type": "user.time_zone_changed", "userId": "...", "from": "...", "to": "..." }` from `src/app/api/settings/time-zone/route.ts`. Each matching `lifecycle` descriptor is invoked with `trigger: "system"`. Descriptors with `dataHook: true` run whatever the module state; the rest run only when the module is enabled for the install. A failing hook is logged and never rolls back the core write.

**Queue.** Module queue message types keep their existing shapes, so messages already queued when the release deploys still route. Today `import.imap` (`{ kind: "import.imap", jobId }`) is sent on `AGENT_QUEUE` by `enqueueImportJob` (`src/lib/import/jobs.ts`), and dispatched by hand in two places. Both move behind `dispatchModuleQueueMessage(env, queue, body)` in `src/lib/modules/background.ts`, which returns `{ handled: false }` for a kind no manifest declares on that queue, and otherwise `{ handled: true, result }`:

| File | Today | After |
| --- | --- | --- |
| `worker.ts` `queue()` | `else if (isImportJobQueueMessage(msg.body)) await processImportJob(env, msg.body.jobId);` after the agent dispatcher | `else if ((await dispatchModuleQueueMessage(env, batch.queue, msg.body)).handled) { /* ack below */ }` in the same position. The import of `isImportJobQueueMessage` and `processImportJob` is removed. |
| `server/index.ts` `runtime.agentQueue.setConsumer` | `if (isImportJobQueueMessage(body)) await processImportJob(env, body.jobId);` after `processAgentQueueMessage` | `await dispatchModuleQueueMessage(env, "agent", body);`. The outbound and inbound consumers gain the same call at the end, so a future module can use those queues without editing this file. |
| `worker-utils.ts` `QUEUE_MESSAGE_KINDS` | literal `"import.imap": "import"` | core kinds stay literal; module kinds come from the manifests' `queueMessageTypes[].metricClass`. The metric class value stays `"import"`, so `kite_metrics` series do not change. |

`dispatchModuleQueueMessage` finds the manifest entry by `kind` (and queue), then calls `invokeCapability(moduleId, entry.capability, body, { trigger: "queue", viewer: null, ... })`. When the result is `module_disabled`, the consumer **acks** the message (it does not retry) and logs `queue.module_disabled` with the module and kind; the handler never runs, and nothing else changes. A `handler_error` or `timeout` result is rethrown so the consumer retries as it does today. An unknown kind still falls through to the existing `"Unknown queue message type"` error.

**Cron.** `runModuleCronTasks(env, cron, now)` runs every manifest `cronTasks` entry whose `schedule` matches, through `invokeCapability` with `trigger: "cron"`, catching and logging each failure separately. `every_tick` matches every trigger.

| File | Today | After |
| --- | --- | --- |
| `worker.ts` `scheduled()` | `ctx.waitUntil(resumeStalledImportJobs(env));` on every trigger (`*/5 * * * *` and `0 2 * * *`) | `ctx.waitUntil(runModuleCronTasks(env, controller.cron, new Date(controller.scheduledTime)));` in the same place; the `resumeStalledImportJobs` import is removed. |
| `server/runtime/scheduler.ts` | does not call `resumeStalledImportJobs` at all | calls `runModuleCronTasks(env, "*/5 * * * *", now)` in its existing 5-minute branch, and `runModuleCronTasks(env, "0 2 * * *", now)` with the daily backup. This gives Node the stalled-import safety net it lacks today. |

A disabled module's cron task is skipped by `invokeCapability` (`module_disabled`) and logged at debug level.

**Import specifics.** See §15.

### 11.8 For you, Activity, palette, composer

For you and the reader card slot render suggestion cards from the module's lazy client chunk (§3.6) and filter kinds and counts by module. Activity labels come from the manifest `actionLabels` and record refs, and undo goes through §11.2. The palette reads the command registry. The composer renders module slots (§3.7).

## 12. Calendar extraction

Move without behaviour change, then gate. Code stays in `src/lib/calendar/`; the module files are thin adapters, and a later cleanup can move files once the platform is stable.

- `manifest.ts`: pages `/calendar`; API `/api/calendar`; nav (mailbox selector link, `module-tabs` Calendar tab); commands (`calendar.open`, `calendar.go_to_date` with `params: { date }`, `calendar.new_event` as a client `open_dialog`); kind `calendar:event`; webhook event labels; grants `calendar.read`, `calendar.write`; MCP scopes `mcp:calendar-read`, `mcp:calendar-write` with their grants; search section `events`; action labels and reason texts.
- `capabilities.ts`:
  - one descriptor per name in `CALENDAR_TOOL_NAMES` (`src/lib/calendar/tools.ts`), with `surfaces: ["assistant_tool", "mcp_tool"]`, the existing descriptions, `inputSchema` from `calendarToolSchemas`, and scopes from `calendarToolScope` mapped to grants (`calendar.read` or `calendar.write`);
  - `search` (`search: { section: "events" }`), `resolveRefs` (`refs: { kinds: ["calendar:event"] }`);
  - `invite` (`triage_step`), `calendar_invite` (`suggestion_kind`), and one `action` per existing invite action type (accept, decline, propose, update, remove);
  - `timeZoneChanged` (`lifecycle`, `user.time_zone_changed`, `dataHook: true`), taking the series-freezing code out of the time zone route;
  - three `webhook_event` declarations; `promptFragment` with today's calendar prompt text.
- `server.ts`: handlers that call `runCalendarTool` and the existing invite and availability code. The invite files under `src/lib/agent/auto-read/` (`invite.ts`, `invite-utils.ts`, `invite-actions-utils.ts`, `calendar-effects.ts`, `calendar-undo.ts`) are imported only from here, so the rest of `src/lib/agent/auto-read/` stops importing calendar code. RSVP replies and invitations go out through `moduleHost.mail.send`.

## 13. Booking extraction

- `manifest.ts`: pages `/booking`, `/book` and `/c` (the last two public); API `/api/booking`, `/api/public/booking` (public); nav (`module-tabs` Booking tab, account menu "Booking page" link); commands (`booking.open`, `booking.open_event_type` with `params: { id }`, `booking.copy_link` as a client `invoke`); kinds `booking:event_type`, `booking:appointment`; webhook event label; grants `booking.read`, `booking.write`; `dependsOn: ["calendar"]`.
- `capabilities.ts`: `workingHours` (`service`, input `{ userId }`, output the first enabled `booking_events` row's weekdays, time ranges and time zone, or `null`); `resolveRefs` for both kinds; `userCreated` (`lifecycle`, `user.created`, `dataHook: false`); the `booking.appointment.created` declaration.
- `server.ts`: `userCreated` calls `ensureBookingUsername` (`src/lib/booking/username.ts`). Account creation (`src/app/api/accounts/create.ts`) and registration (`src/app/api/auth/register/route.ts`) stop calling it inside their transaction, so a failure is logged instead of rolling back the account. `GET /api/booking` already assigns a username lazily when missing, so a user created while Booking was off gets one on first visit.
- `createBookedCalendarEvents` inserts `booking_appointments` rows and emits the webhook through `moduleHost.emitWebhook`.

## 14. Email templates extraction

What exists today, verified in the code:

- Templates are `messages` rows with `status = "template"` and `direction = "outbound"`, created by `POST /api/templates` (`src/app/api/templates/route.ts`, title in `subject`, body in `htmlBody`/`textBody`, sender resolved with `getDraftSender`), listed by `GET /api/templates` (the user's own, newest 200) and deleted by `DELETE /api/templates/[id]` (`deleteMessageWithObjects`). The `email_templates` table is not used.
- The UI is the "Template" submenu (`src/components/compose/template-menu.tsx`) and the "New template" dialog (`src/components/compose/new-template-dialog.tsx`), both mounted from `src/components/compose/schedule-send-menu.tsx`, which `compose-form.tsx` renders with `onApplyTemplate`.
- There is no templates page, nav item, queue, cron, webhook, assistant tool, MCP tool, JMAP method or REST endpoint.

The module:

- `manifest.ts`: API `/api/templates`; composer slot `{ id: "templates.send-menu", slot: "send-menu", order: 10, label: "Template" }`; kind `templates:template`; grants `templates.read`, `templates.write`; `messageStatuses: ["template"]`; no pages, nav or navigation commands.
- `capabilities.ts`: `resolveRefs` for `templates:template` (label from `subject`, `href: null`). No tools. Decision: no new assistant or MCP tool, because none exists today and the composer is the only user; `templates.insert` is the designed in-tab command for later (§6.3).
- `server.ts`: the `resolveRefs` handler.
- Client: `src/components/modules/templates/client.tsx` exports `composerSlots["templates.send-menu"]`, which renders the moved `TemplateMenu` and `NewTemplateDialog` and calls `composer.applyContent`.
- Routes: both template routes are wrapped in `withModule("templates", ...)` and call `checkUser`.
- `schedule-send-menu.tsx` no longer imports any template file (enforced by §19.1).

Two pre-existing behaviours were found and are left as they are in this Mission (§22): the JMAP account-level mailbox (`mailboxRefCondition` with `ref.kind === "account"` in `src/lib/jmap/email-query.ts`) does not exclude template rows, and the mbox export (`exportMailboxToMbox`, which filters only on `mailboxId`) includes them.

## 15. Mail import extraction

What exists today, verified in the code:

- Page `src/app/(settings)/settings/import/` with `src/components/settings/import-messages.tsx`, `import-messages-utils.ts` and `import-jobs-panel.tsx`; Settings nav item `{ href: "/settings/import", label: "Import" }` in the "Mailbox" group next to Export (`section-nav-utils.ts`).
- API under `/api/import`: `messages` (mbox and eml upload, parsed in the request), `imap` (one-shot import), `imap/folders` (folder list), `jobs` (list and create background jobs) and `jobs/[id]` (cancel). They authenticate with `getCurrentUser`.
- `src/lib/import/`: `imap.ts` (a raw-socket IMAP client over `connect()`), `mbox.ts`, `jobs.ts`, `service.ts` (`importMessagesToMailbox`), `destination.ts` and helpers.
- `import_jobs` (`src/db/schema/import-jobs.ts`), statuses `pending | running | completed | failed | cancelled`, with an 8-minute lease, up to 5 attempts and the source password sealed while the job is active.
- Queue: `enqueueImportJob` sends `{ kind: "import.imap", jobId }` on **`AGENT_QUEUE`** (not the outbound queue). `worker.ts` and `server/index.ts` dispatch it by hand; `worker-utils.ts` maps it to the `import` metric class.
- Cron: `worker.ts` calls `resumeStalledImportJobs` on every trigger; it re-enqueues active jobs with an expired lease that have not moved for two minutes (up to 10), and runs one inline when there is no queue binding. The Node scheduler does not call it.
- No webhook event, assistant tool, MCP tool or JMAP method.

The module:

- `manifest.ts`: page `/settings/import`; API `/api/import`; nav `{ placement: "settings-nav", group: "Mailbox", label: "Import", href: "/settings/import", keywords: ["imap", "migrate"] }`; command `import.open`; kind `import:job`; grant `import.run`; `queueMessageTypes: [{ kind: "import.imap", queue: "agent", capability: "processImportJob", metricClass: "import" }]`; `cronTasks: [{ name: "resumeStalledImports", schedule: "every_tick", capability: "resumeStalledImports" }]`; `adminNotes` (§7).
- `capabilities.ts`: `processImportJob` (`queue`, input `{ kind: "import.imap", jobId }`, `timeoutMs` above the run budget), `resumeStalledImports` (`cron`, input `{}`), `resolveRefs` for `import:job`. No webhook event (none exists today; none is added), no tools.
- `server.ts`: `processImportJob` first checks the job owner with `moduleHost.modules.isEnabledFor(ctx, job.userId, "import")` and returns `{ skipped: "module_disabled" }` without touching the row when the owner is restricted; otherwise it calls today's `processImportJob(env, jobId)`. `resumeStalledImports` runs today's `resumeStalledImportJobs` with the same per-owner filter, so a restricted user's jobs are not re-enqueued every tick. Imported messages are written through `moduleHost.mail.importMessages`.
- The IMAP raw socket stays as is: `src/lib/import/imap.ts` keeps using `connect()` from inside the module handler on both runtimes. Turning the module off is how an owner removes that outbound socket surface.
- Routes: every route under `/api/import` is wrapped in `withModule("import", ...)` and calls `checkUser` after `getCurrentUser`.

**What "off" does to jobs. Decision: paused, not failed.** When Mail import is off for the install, or for the job's owner:

- `import.imap` messages are acked and skipped with `module_disabled` (§11.7); the cron safety net does not run.
- The `import_jobs` row is left exactly as it is: `pending`, or `running` with a lease that expires. No status is added (the schema has no `paused`, and adding one would touch every status check); no attempt is counted; the sealed source password stays, as for any active job.
- A run already in progress finishes its current batch (up to `MESSAGES_PER_RUN`), as a running automatic-reading job does; its re-enqueue is then skipped.
- When the module is turned back on, `resumeStalledImports` re-enqueues the job on the next cron tick (within about five minutes on Workers and on Node), and it continues from `cursorUid`.

Marking jobs `failed` was rejected: it would clear the cursor's purpose and the credentials, force users to start over, and turn a reversible switch into data loss. The Modules page note (§7) tells the owner that paused jobs keep their saved source credentials until they finish or are cancelled; cancelling needs the module on, because the cancel route is gated.

## 16. Sandboxed apps (later design, not built here)

The types reserve `runtime: "sandboxed"`. A sandboxed app is a signed JavaScript bundle that the owner installs and that runs sandboxed **inside the user's own Kite**, never on a publisher's servers. Building it is a separate spec; this section records the design so the builtin platform does not close it off.

**Runtimes.**

- On Cloudflare: Dynamic Workers (the Worker Loader binding, `worker_loaders: [{ binding: "LOADER" }]` in `wrangler.jsonc`). It is in open beta and available only on the Workers Paid plan, so Kite feature-detects `env.LOADER` and shows sandboxed apps as unavailable without it; builtin modules keep working either way.
- On Node and Docker: a workerd sidecar. Open-source workerd supports the `workerLoader` binding, but only with `--experimental`, so the version is pinned. workerd is not a hardened sandbox, and whether it enforces `limits` is unconfirmed, so the sidecar runs as its own container (non-root, read-only filesystem, no Docker socket, dropped capabilities, seccomp, memory and CPU limits, egress only to the Node callback port), and Node enforces call timeouts and restarts the sidecar when needed. A small trusted runner Worker in the sidecar receives authenticated `invoke` requests from Node (HMAC per request, as the relay does) and loads apps with the same loader API.

**Loading.**

- Apps are loaded with `LOADER.get(id, getCode)` and a stable, content-addressed id such as `<installId>:<version>:<sha256(bundle)>:<sha256(grants + compatibility)>`, never `load()`, which creates a new billed isolate per call. The same id must always return identical code; the `getCode` callback re-verifies the bundle signature before returning the module map. Isolates are not guaranteed to persist, so apps keep no state in memory.
- `globalOutbound: null` blocks all network access. An app that declares `network.allow` hosts, approved by the owner, gets a gateway entrypoint instead that enforces the allowlist, injects stored secrets and logs every request.
- `limits: { cpuMs, subRequests }` per invocation, from the manifest within install maximums. `tails` route each app's console output and exceptions to a per-app log.
- At most 4 distinct Dynamic Workers can be in flight per Worker request, so fan-out (an event for every installed app) goes through the queue, one message per app and event, never a loop inside one request. The queue routing in §11.7 already dispatches by manifest-declared kind, so app messages reuse it.

**The contract does not change.** A sandboxed app ships a manifest of the same shape with `runtime: "sandboxed"` and the same `CapabilityDescriptor` list in JSON. An app adapter (`src/lib/modules/sandbox-adapter.ts`, later) registers those descriptors and implements `invokeCapability` for the app by calling its exported `App.invoke(name, input, ctx)` entrypoint over Workers RPC (or JSON over HTTP to the sidecar). Inputs, contexts and outputs are already JSON, which Workers RPC copies by value; functions and class instances would cross as stubs or be refused, which is why the contract forbids them. Errors cross as `{ code, message }` values. Because every core surface already goes through `invokeCapability`, the assistant, MCP, search, refs, triage, actions, webhooks, lifecycle, cron, queue and JMAP pick up app capabilities with no change. Apps do not get composer slots (§3.7); they contribute UI through commands.

**Host API.** Builtin modules use `ModuleHost` (§3.5) as plain functions. A sandboxed app gets the same surface as one RPC object, `KiteHost`: a `WorkerEntrypoint` exported from `worker.ts` (beside `RealtimeHub`) and handed to the app as `env.KITE` through `ctx.exports.KiteHost({ props: { appId, installId, version, grants } })`. `ctx.props` is held by the loader and never visible to the app, so identity and grants cannot be forged. Methods mirror `ModuleHost`: scoped calendar and mail reads, `mail.send` through the normal send path counting against the acting user's limits, `emitWebhook`, `resolveRefs`, `audit`, and an app-private storage namespace (`apps/<installId>/...`). No raw D1, R2, Queue or `EMAIL` binding is ever passed. Per-call user and mailbox context travels as an argument that the host re-validates against its own job or session record (an opaque call token minted by the host), never trusted from the app. Every input is validated at the host boundary with a size cap well below the 32 MiB RPC limit; large content moves as attachment handles.

**Trust.**

- Signature verification: bundles are signed by the publisher; Kite verifies the signature and the bundle hash at install and on every `getCode`.
- Install-time approval: the manifest requests grants and network hosts; the owner approves a subset, which becomes the app's `grants`. Changing grants changes the loader id, so a cached isolate never keeps old grants.
- Per-app identity: every app action is attributed to the app and the acting user in `audit_logs` and, for side effects, in a write-before-effect log like `agent_actions`.
- An app is disabled like any module (`module_settings`), and a kill switch is checked before every invocation. Its data lives in its own namespace, so disabling or uninstalling never touches core data.
- UI comes from the command registry and record refs (an app can add commands and link records), not from injected React. Iframe panels on a separate origin may come later.

This replaces the "separate services" idea in Roadmap milestone 19.

## 17. Performance and bundle size

- Module state costs one indexed query per request at most, usually zero (isolate cache). Pages already make a session query; the guard reuses `getUserFromSession`.
- `invokeCapability` adds a JSON check and a zod parse per call; both are small next to a D1 query. Search fan-out runs providers in parallel. Queue and cron dispatch add one manifest lookup and one state read (cached) per message or tick.
- Manifests are small data. Descriptors and zod schemas stay server-side. Module client code (calendar pages, dialogs, suggestion cards, command handlers, the template menu and dialog) is code-split by route or loaded through the client registry. Moving the template menu out of the composer is expected to shrink the composer chunk slightly.
- `npm run quality:report` bundle budgets must not regress. Measure before and after each milestone and record both numbers in the PR. The branch must pass the existing budgets unchanged. If it cannot, the worker stops and reports to the maintainer with the measurement, instead of raising a budget. The budget sums all emitted files, so lazy loading alone does not lower the gated number; code that moves must actually shrink or stay the same size.

## 18. Rollout

- Existing installs: migration 0062 seeds all four modules enabled, so nothing changes until the owner turns something off.
- Deploy before migrate (the normal Kite order): missing tables mean all enabled and all allowed, the Events search section is empty, appointment links are not recorded, and the admin `/modules` page says "Apply the pending database update to manage modules" with the toggles disabled.
- In-flight queue messages: `import.imap` keeps its shape and queue, so messages enqueued by the previous release are routed by the new dispatcher.
- New installs: the setup path applies all migrations, so all four modules start enabled.
- Future modules: `defaultEnabled` applies until the owner changes it; no seed row is needed.
- Node runtime: identical behaviour; migrations run at start, and better-sqlite3 supports FTS5. Node gains the stalled-import cron safety net (§11.7).
- `CHANGELOG.md` Unreleased: a user-facing entry ("Turn Calendar, Booking, Email templates and Mail import off for everyone or for some users", "Search finds calendar events") and a note that migration 0062 must be applied.

## 19. Test plan

### 19.1 Unit (`tests/*.test.mjs`, no bindings)

| File | Covers |
| --- | --- |
| `tests/module-registry.test.mjs` | Manifest ids unique; dependency graph acyclic; page and API prefixes do not overlap, and none covers `/settings/export` or `/api/export`; manifests import nothing server-only, no zod schemas and no React (text scan of imports); every descriptor list survives a `JSON.stringify`/`JSON.parse` round trip deep-equal (no functions); descriptor names unique per module; only `assistant_tool` and `mcp_tool` combine; every invokable descriptor has a handler and every handler a descriptor; every `inputSchema` equals `z.toJSONSchema` of its zod schema; every `queueMessageTypes` and `cronTasks` entry names a matching `queue` or `cron` descriptor and the reverse; queue kinds are unique across modules and do not collide with core kinds; suggestion kinds named by actions exist; manifest labels exist for every action type and reason. |
| `tests/module-boundary.test.mjs` | `invokeCapability` with a test-only module: rejects functions, class instances, `Date`, `Map`, `undefined`, `bigint`, cycles, depth over 32 and inputs over 1 MiB with `invalid_input`; rejects inputs that fail `inputSchema`; rejects non-JSON or schema-failing outputs with `invalid_output`; answers `unknown_capability`, `module_disabled` (except data hooks), `forbidden` for missing grants and for a `mailboxBound` mailbox outside `ctx.mailboxIds`, `timeout`, and `handler_error` without leaking the thrown message; never throws. |
| `tests/module-imports.test.mjs` | Only `src/lib/modules/invoke.ts` imports `src/lib/modules/server-registry.ts`, and only `server-registry.ts` imports any `src/lib/modules/<id>/server.ts`. Core files do not import `@/lib/modules/<id>` for any module, `@/lib/calendar`, `@/lib/booking`, `@/lib/import` (or `./src/lib/import`), `@/components/modules/<id>`, or the moved template components: `worker.ts`, `worker-utils.ts`, `server/index.ts`, `server/runtime/scheduler.ts`, `src/lib/agent/chat.ts`, `src/lib/agent/model.ts`, `src/lib/agent/tools.ts`, `src/lib/mcp/server.ts`, `src/lib/mcp/auth.ts`, `src/lib/email/webhooks.ts`, `src/app/api/search/route.ts`, `src/app/api/messages/route.ts`, `src/lib/jmap/processor.ts`, everything under `src/lib/agent/auto-read/` except the calendar invite files listed in §12, `src/app/(dashboard)/for-you/`, `src/components/shortcuts/`, `src/components/compose/`, `src/components/settings/section-nav-utils.ts`, `src/components/agent/agent-activity-utils.ts`, `src/components/mailbox-selector.tsx`, `src/app/api/settings/time-zone/route.ts`, `src/app/api/accounts/create.ts`, `src/app/api/auth/register/route.ts` and the two import-export redirect pages. Core client code reaches module client code only through `client-registry.ts`. Module directories do not import `@/lib/email/send` or `@/lib/email/webhooks`. The allowlist starts empty; any entry needs a written reason in the test. |
| `tests/module-queue-cron.test.mjs` | `dispatchModuleQueueMessage` with the real manifests and a stub handler map: routes `import.imap` on the agent queue to `processImportJob`; returns `handled: false` for core and unknown kinds; with Import off, acks and reports `module_disabled` without calling the handler; rethrows `handler_error` so the consumer retries. With the `SqliteDatabase` from the Node runtime: an `import_jobs` row is unchanged (status, attempts, cursor, password) after a skipped message; the import handler skips a job whose owner is restricted; `runModuleCronTasks` matches `every_tick` and exact schedules, skips disabled modules and isolates one task's failure from another; the resume handler filters out restricted owners. |
| `tests/module-composer-slots.test.mjs` | The pure slot helper lists only enabled modules' `send-menu` declarations in `order`, and reports "no slots" (no separator) when Templates is off; `moduleOwnedMessageStatuses` and the message-list status rule exclude `template` always and return no rows for `status=template` when Templates is off for the viewer. |
| `tests/module-state.test.mjs` | `effectiveModules`: install off, dependency off, user restricted, owner never restricted, missing rows use `defaultEnabled`; "no such table" means all enabled. Uses `SqliteDatabase` from the Node runtime for the table reads. |
| `tests/module-route-guard.test.mjs` | §10.2 scan over all four modules' prefixes, including the `getCurrentUser` import routes; plus a handler-level test that install-off answers 404 before auth, user-off answers 404 after auth, signed-out on-module answers 401. |
| `tests/record-refs.test.mjs` | Parse and format; same-origin href check rejects `//x`, `https:`, `javascript:`; `href: null` renders as text; a failed or disabled resolver yields unavailable refs with neutral labels. |
| `tests/module-commands.test.mjs` | Palette commands and shortcuts filter by enabled modules; `mail.export` stays with Import off; href templates fill and encode params and refuse unknown or invalid params; the `open_page` schema enum contains only enabled navigate commands; client commands are listed only while a handler is available. |
| `tests/module-webhooks.test.mjs` | Event list merge; validator limit; `MODULE_DISABLED` refusal; `emitWebhook` refuses events of another module and invalid payloads; disabled module events are not emitted. |
| `tests/module-jmap.test.mjs` | Test-only module capability and method merge (§11.4). |
| `tests/module-migration.test.mjs` | Applies all migrations to SQLite; checks the four seed rows, FTS triggers on insert, update and delete, and `rebuild`; checks backup lists contain the new tables in FK order, `calendar_events_fts%` is internal, `import_jobs` is still internal and `email_templates` is still in the `accounts` group. |
| `tests/backup-module-tables.test.mjs` (new, next to the existing `backup-*` tests) | Pre-0062 backup restores after 0062 with defaults; post-0062 backup round-trips module state and appointments. |
| `tests/agent-auto-read-*.test.mjs` (extend) | Triage skips the calendar step with `module_disabled`; core rejects step suggestions of another module's kind, invalid payloads and more than three; `listSuggestions` filters kinds and counts; action execute and undo go through invoke, keep write-before-effect and are idempotent by `actionId`; undo refused while off and allowed again when on. |
| `tests/imap-*.test.mjs` (existing) | Keep passing unchanged; the IMAP client and batching are not modified. |
| `tests/admin-route.test.mjs` (extend) | `/modules` is primary-only. |

### 19.2 e2e (`e2e/27-modules.spec.ts`)

Every test restores all four modules and user access in `finally`, because the e2e database is shared across specs.

1. The owner turns Calendar off: the Calendar link and tabs disappear, `/calendar` and `/booking` show the not-found page, `/api/calendar/events` answers 404, the palette has no calendar commands, and turning Calendar on restores everything.
2. Turning Booking on while Calendar is off is refused; the page shows "Off because Calendar is off".
3. Booking off: `/book/<user>` and `/c/<username>` answer 404 for a signed-out visitor; on again, they render.
4. Per-user restriction: the owner restricts a second user from Calendar; that user sees no Calendar link and gets 404; the owner still sees it.
5. A non-owner admin does not see Modules in the admin navigation, opening `/modules` redirects to `/admin`, and `PUT /api/admin/modules` answers 403.
6. Assistant: with the fake model, the recorded chat request's `tools` contains `get_schedule` and an `open_page` enum with `calendar.open` when Calendar is on, and neither when it is off. A scripted `open_page` call renders a link.
7. Search: an event titled with a unique word appears in the Events section of the search dropdown and opens the event; with Calendar off, the section is absent.
8. Webhooks: the event picker lists the calendar events when on; creating a webhook with `calendar.event.created` while Calendar is off is refused.
9. The not-found page renders for an unknown URL in Kite, Classic and dark mode.
10. Templates off: opening the composer's send menu shows the schedule options and no "Template" entry, no request to `/api/templates` is made, `GET /api/templates` and `DELETE /api/templates/<id>` answer 404, and `/api/messages?status=template` returns no rows. Templates on: the Template submenu is back and a template created earlier still applies its subject and body.
11. Import off: Settings shows Export but not Import in the "Mailbox" group, `/settings/import` shows the not-found page, `GET /api/import/jobs` and `POST /api/import/messages` answer 404, the palette has no `import.open`, and `/settings/import-export` redirects to `/settings/export`.
12. Export with Import off: `/settings/export` renders, and `GET /api/export/messages?mailboxId=<seeded mailbox>` returns `application/mbox` with the seeded messages.
13. Queued import skipped: with Import on, create an IMAP job through `POST /api/import/jobs` against the unresolvable public hostname `imap.no-such-host.example.net` (synthetic, fails like an unreachable server and is retried; a local host such as `127.0.0.1` cannot be used, because `assertSafeImapHost` refuses it as a permanent failure and the job fails without a retry), and poll `GET /api/import/jobs` until its first attempt has failed (`attempts` 1, `lastError` set, retry queued 30 seconds out). Turn Import off and wait past the retry (poll up to 60 seconds with `test.slow()`), then turn it on and check that the job is still active with `attempts` 1, so the retry was skipped without running. The cron path is covered by `tests/module-queue-cron.test.mjs`, because e2e cannot fire the cron trigger.

Supporting changes: `scripts/agent/fake-model-server.mjs` and `e2e/support/fake-model.ts` gain a streaming (`stream: true`) branch and scripted tool calls, and record the last request's `tools`; `/modules` joins `WARM_UP_ROUTES` in `e2e/global-setup.ts`; `e2e/README.md` gets a row for spec 27. Check that `e2e/04-compose.spec.ts`, `e2e/07-settings.spec.ts` and `e2e/14-section-nav.spec.ts` still pass with all modules on.

### 19.3 Manual checks

- `npm run dev` with an existing local database: apply 0062 from the admin card, confirm nothing changes, then toggle each module.
- Deploy-before-migrate: run the branch against a database without 0062 and confirm the calendar, booking, templates, import, export and assistant work and `/modules` explains the pending update.
- Node: `npm run build:node` and start the server; repeat the toggle checks, and confirm a stalled import resumes from the Node scheduler.

## 20. Documentation

| File | Change |
| --- | --- |
| `docs/modules.md` (new) | What modules are, which exist, what turning one off does and does not do (including paused imports and that export always works), per-user access, the 30-second propagation, and how to add a builtin module (manifest, descriptors, schemas, handlers, `ModuleHost`, composer slots, queue and cron entries, guard, tests, backups). |
| `CLAUDE.md` | A "Modules live in `src/lib/modules/`" architecture section: manifest versus descriptors, `invokeCapability` as the only path into module code, `ModuleHost`, the import rules the tests enforce, guards, record refs, the registry-wide scope rule, data hooks, composer slots; update the `worker.ts` queue and cron description to say module message kinds and cron tasks are dispatched through the registry; add `src/db/schema/modules.ts` to the schema paragraph. |
| `docs/assistant.md` | Tools and invite handling depend on the Calendar module; the `module_disabled` reason; `open_page`. Keep `npm run docs:check` passing. |
| `ROADMAP.md` | Milestone 19 rewritten to "builtin modules first (Calendar, Booking, Email templates, Mail import), sandboxed apps inside your own Kite later" with a link to this spec; the ideas line about extensions as separate services marked superseded. |
| `docs/roadmap-complete-suite.md` | Committed; the milestone 19 text updated to match. |
| `docs/specs/drive-storage.md` | Its planned migrations 0062 and 0063 become 0063 and 0064 (the references near lines 320, 619 and 627). |
| `CHANGELOG.md` | §18. |
| `e2e/README.md` | Row for `27-modules`. |

## 21. Step 2: implementation

The work runs on `mission/module-platform` in three milestones. Do not deploy, run remote migrations or rename resources.

Checks inside a milestone are targeted: the relevant unit tests (`node --test tests/<file>.test.mjs`), `npm run typecheck`, `npm run lint`, and the relevant e2e specs (`npx playwright test e2e/<file>.spec.ts`). Run Prettier on every touched file (`npx prettier --write <file>`). Measure the bundle (§17) at the end of each milestone. Commit locally as work completes. **Pushing the branch and opening the PR happen only after the maintainer confirms**: when Milestone 3 is green, stop and ask before pushing. After confirmation, push only `mission/module-platform`, open the PR against `main`, and leave merging to a human.

### Milestone 1: platform

- Work:
  - Commit this spec and `docs/roadmap-complete-suite.md`.
  - `src/lib/modules/`: types, `registry.ts`, `capability-registry.ts`, `server-registry.ts`, `json-utils.ts`, `invoke.ts`, `host.ts`, `state.ts`, `state-utils.ts`, `route-guard.ts`; `src/components/modules/client-registry.ts` and `modules-context.tsx`.
  - Manifests, descriptor lists and schemas for `calendar`, `booking`, `templates` and `import` (handlers may be thin until Milestone 2).
  - Migration 0062, `src/db/schema/modules.ts`, `drizzle.config.ts`, `src/db/index.ts`, backup lists (§9).
  - `/api/auth/me` `modules` and `useModules()`.
  - Guards and not-found: `requireModulePage`, `requirePublicModulePage`, `withModule` on every route under `/api/calendar`, `/api/booking`, `/api/public/booking`, `/api/templates` and `/api/import`; the calendar layout split; the booking, public booking and `/settings/import` layouts; the two import-export redirect pages; `src/app/not-found.tsx`.
  - The Modules admin page (`src/app/(admin)/modules/page.tsx`), `/api/admin/modules`, the per-user section and `PUT /api/admin/accounts/[id]/modules`, audit rows, `primaryOnlyPrefixes`, admin notes.
- Acceptance: an upgraded database and a database without 0062 both behave as before; backups round-trip both ways; §7 holds; every module page and API answers as in §10.1 and §10.2; export is never gated.
- Tests: registry, boundary, imports (with the core files not yet moved listed as pending, emptied in Milestone 2), state, route guard, migration and backup unit tests; `admin-route`; e2e scenarios 1 to 5, 9, 11 and 12 written in `27-modules.spec.ts`.

### Milestone 2: surfaces

- Work:
  - Assistant: tool and prompt assembly from descriptors, `open_page`, fake-model streaming.
  - Automatic reading: the triage step adapter and calendar step handler, action handlers through invoke, suggestion filtering and lazy cards, undo refusal, `workingHours`.
  - MCP adapter and scope rules, key creation refusal; JMAP merge.
  - Webhooks: one event list, `emitWebhook`, the four new events, refusal, retry skip.
  - Record refs: `resolveRecordRefs` and all `resolveRefs` handlers, Activity labels.
  - Nav and commands: nav registry consumers (mailbox selector, account menu, calendar tabs, Settings nav), `core-commands.ts` and module commands, palette and shortcut filtering.
  - Search: the calendar `search` handler, `/api/search`, the dropdown, the calendar `event` parameter; `booking_appointments` writes; lifecycle events.
  - Templates: move the template menu and dialog into `src/components/modules/templates/`, the `ComposerSlot` in `schedule-send-menu.tsx`, `composer.applyContent`, the message-list owned-status rule.
  - Import: `dispatchModuleQueueMessage` and `runModuleCronTasks` wired into `worker.ts`, `server/index.ts`, `server/runtime/scheduler.ts` and `worker-utils.ts`; the `processImportJob` and `resumeStalledImports` handlers with the per-owner check; `moduleHost.mail.importMessages`.
- Acceptance: every row of §10.3; the import test's pending list is empty; no core file named in §19.1 imports module code.
- Tests: agent, boundary, imports, queue and cron, composer slot, record-ref, command, webhook and JMAP unit tests; e2e scenarios 6, 7, 8, 10 and 13.

### Milestone 3: finish

- Work: complete `e2e/27-modules.spec.ts` (all 13 scenarios, Kite, Classic and dark mode where there is UI), §20 docs, CHANGELOG, the bundle measurement against the unchanged budgets.
- Then run the full chain in order and fix every failure: `npm run check`, `npm run build`, `npm run build:node`, `npm run test:relay:integration`, `npx playwright test`, `npm run check:mission`.
- Acceptance: the full chain passes; `npm run docs:check` passes; `npm run quality:report` passes with the existing budgets unchanged (otherwise stop and report, §17).
- Then ask the maintainer before pushing.

## 22. Decisions

Made with the maintainer before this spec was written:

1. Only the primary admin (owner) manages modules and per-user module access.
2. Calendar gets FTS5 search (`calendar_events_fts`) and an "Events" section in the search dropdown.
3. Module webhook events are `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted` and `booking.appointment.created`; subscribing to a disabled module's event is refused.
4. UI commands feed the command palette and one chat navigation tool (`open_page`). Assistant actions in the tab are designed for later with a per-effect confirmation policy, and delete always confirms.
5. `docs/roadmap-complete-suite.md` is committed, and this spec supersedes milestone 19's "separate services" wording.

Made at spec approval:

6. Email templates and Mail import (IMAP plus mbox and eml upload) are extracted as builtin modules in this Mission. Alerts and auto-reply stay later.
7. Mailbox export stays core and always available; nothing in the Import module can hide it.
8. `booking_appointments` is approved, with no backfill.
9. Webhook first attempts stay inline, as for message events.
10. Non-owner admins never see the Modules page.
11. Module state is cached for 30 seconds per isolate, with immediate effect in the isolate that handled the write and on the next `/api/auth/me`.
12. The branch is pushed and the PR opened only after the maintainer confirms.

Made in this spec:

- Core reaches module code only through `invokeCapability` with JSON input, a JSON context and a JSON result; modules reach core services only through `ModuleHost`. Tests enforce both directions.
- JSON Schema is the wire format; zod is the builtin validator, and descriptors are generated from the zod schemas.
- Pages are gated in server layouts with `notFound()`, not in proxy or middleware.
- Install-level off answers 404 before authentication; per-user off answers 404 after it.
- Module state lives in `module_settings` and `user_module_access`; no row means default; no table means all enabled.
- MCP and REST scope lists stay registry-wide; only tool listing and key creation follow module state.
- `user.time_zone_changed` is a data hook and always runs; Booking's `user.created` hook runs only when enabled and never rolls back account creation.
- Templates contribute to the composer through a `send-menu` composer slot loaded lazily; with Templates off the composer has no template UI and loads no template code. Templates get no assistant or MCP tool and no navigation command (there is no page); `templates.insert` is designed for later.
- Module-owned message statuses (`template`) are excluded from message lists generically, and returned on request only when the owning module is enabled for the viewer.
- Module queue message types and cron tasks are declared in the manifest and dispatched by `dispatchModuleQueueMessage` and `runModuleCronTasks`; `worker.ts`, `server/index.ts`, `server/runtime/scheduler.ts` and `worker-utils.ts` hold no per-module code. Queue message shapes and metric classes stay as they are.
- A disabled module's queue messages are acked and skipped with `module_disabled`; its cron tasks do not run.
- Import jobs pause while Import is off (row untouched, credentials kept, no attempt counted) and resume on the next cron tick after it is turned back on; they are never marked failed by the switch.
- Node gains the stalled-import cron safety net through `runModuleCronTasks`.
- Bundle budgets are not raised; a worker that cannot meet them stops and reports.

Found while verifying, not changed in this Mission (follow-ups for the maintainer):

- Template rows are visible through JMAP's account-level mailbox (`mailboxRefCondition` returns every row of the mailbox for `ref.kind === "account"`) and are included in the mbox export (`exportMailboxToMbox` filters only on `mailboxId`). Both predate this spec. Recommended follow-up: exclude module-owned statuses in both places.
- The `email_templates` table is unused by application code. Recommended follow-up: drop it in a later migration and add it to `RETIRED_BACKUP_TABLES`.
