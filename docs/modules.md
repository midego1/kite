# Modules

Kite's core is mail: mailboxes, domains, contacts, accounts, settings, backups, search, the assistant, MCP, the API, JMAP, webhooks and mailbox export. Core is always on. Around it sit **modules**, feature areas the owner (the primary admin) can turn off for everyone or for some users. The design is in the [module platform spec](specs/module-platform.md).

## The four modules

| Module | What it is | Depends on |
| --- | --- | --- |
| **Calendar** | The personal calendar at `/calendar`, its API under `/api/calendar`, the calendar tools in assistant chat and MCP, calendar invitations in automatic reading, the Events section of the search dropdown and the `calendar.event.created`, `calendar.event.updated` and `calendar.event.deleted` webhook events. | nothing |
| **Booking** | Booking pages: the settings page at `/booking`, the public pages at `/book/...` and `/c/...`, the APIs under `/api/booking` and `/api/public/booking`, and the `booking.appointment.created` webhook event. Booked appointments land in the host's calendar. | Calendar |
| **Email templates** | The **Template** entry in the composer's send menu (insert a template, save a new one) and its API under `/api/templates`. There is no templates page. | nothing |
| **Mail import** | Settings → Import (`/settings/import`): IMAP imports, mbox and eml uploads and background IMAP jobs, with the API under `/api/import`. | nothing |

Every module starts on. A new install and an upgraded one behave exactly as before until the owner turns something off.

## Turning a module off

Open **Admin → Modules** (`/modules`). Only the owner sees this page; other admins do not, and the API answers them with 403. Each module shows its name, what it does, what it depends on and a switch. The page also lists the core areas that have no switch.

Booking needs Calendar. Turning Calendar off also turns Booking off: the page asks first and then shows Booking as "Off because Calendar is off". Turning Calendar on again restores Booking as it was. Turning Booking on while Calendar is off is refused.

### What off does

A module that is off is absent, not broken:

- Its links, tabs, Settings entries and command palette commands disappear.
- Its pages show the "Page not found" page, with HTTP status 404. Its API routes answer 404 for everyone, signed in or not, before any sign-in check. Booking's public pages and the public booking API answer 404 too.
- Assistant chat loses the module's tools, and the `open_page` tool no longer offers the module's pages. MCP stops listing its tools.
- Its webhook events are no longer sent, and a webhook cannot newly subscribe to them (the API answers 400 `MODULE_DISABLED`). New API keys and MCP keys cannot ask for its scopes, for the same reason.
- Search drops the module's section. With Calendar off, the Events section is gone from the search dropdown.
- Automatic reading skips the calendar step and Activity says "Calendar is turned off". Invitation suggestions and their counts are hidden, and accepting one or undoing an invitation action is refused until Calendar is back on. The other steps (reply, summary, phishing) still run.
- With Email templates off, the composer's send menu shows only the schedule options and loads no template code, and the message API returns no template rows.
- With Mail import off, its queued work is skipped: see paused imports below.

### What off does not do

- **Nothing is deleted.** Events, booking pages, appointments, templates and import jobs stay in the database and in backups. Turn the module on again and everything is back.
- **Mailbox export always works.** Settings → Export (`/settings/export`) and the export API are core. Turning Mail import off never hides them, and the old Import and export links send you to Export instead.
- **Old keys keep working.** An API key or MCP key that already has a module's scope keeps authenticating. It only gets 404 or no tools from that module while the module is off.
- **Existing webhook subscriptions keep their events.** They just receive nothing while the module is off.
- **Integrity hooks still run.** When a user changes their time zone, Calendar still freezes their legacy recurring series, so the calendar is correct when it comes back.

### Paused imports

Turning Mail import off pauses background IMAP jobs. They are not failed or cancelled:

- A job keeps its status, its progress and its saved source credentials. No attempt is counted.
- A batch that is already running finishes. Its next batch is skipped instead of running.
- The safety net that restarts stalled jobs does not run while the module is off.
- Within about five minutes of turning Mail import on again, every paused job continues from where it stopped, on Cloudflare and on the Node runtime.

Cancelling a job needs Mail import to be on, because the cancel button and its API belong to the module. The Modules page reminds you that paused jobs keep their saved credentials.

## Per-user access

The owner can also restrict a module for one user under **Accounts → (user) → Permissions → Modules**. A restricted user sees exactly what everyone sees when the module is off: no links, not-found pages and 404 from the API. For Booking that includes the user's own public booking pages. For Mail import it includes the user's background jobs, which pause as above.

The owner is never restricted. Every change to a module switch or to someone's access is written to the audit log.

## When a change takes effect

The browser tab and server that handled a change see it at once. Other open sessions, and other server instances, pick it up within 30 seconds, because Kite keeps the module state in memory for up to 30 seconds. The Modules page says so.

## Before the database update

The switches live in tables that migration 0062 adds. Until an admin applies it, every module is on for everyone, and the Modules page says "Apply the pending database update to manage modules" with the switches disabled. Calendar search returns no events until then.

## Adding a builtin module

Modules are compiled into Kite. They run the same way on Cloudflare and on the Node runtime, from a static registry, with no code loaded at runtime. A module is two halves: a client-safe **manifest** (plain data) and a list of **capability descriptors** (JSON) with zod schemas and handlers on the server. Core only ever calls a module through `invokeCapability(moduleId, name, input, ctx)` with JSON input, a JSON call context and a JSON result. Tests in `tests/module-*.test.mjs` enforce the rules below.

1. **Id.** Add the id to `ModuleId` in `src/lib/modules/module-types.d.ts` and to `MODULE_IDS` in `src/lib/modules/client-data/module-ids.ts`, in the same position as in the registry.
2. **Client data.** Create `src/lib/modules/client-data/<id>.ts` with what browser code needs: the name, navigation items (`nav`, placed in `mailbox-selector`, `account-menu`, `module-tabs` or `settings-nav`), UI commands, composer slots, suggestion kinds and key scope labels. Add it to `CLIENT_MODULES` in `src/lib/modules/client-data/index.ts`. Client components read this slice, never the manifest.
3. **Manifest.** Create `src/lib/modules/<id>/manifest.ts` exporting a `ModuleManifest`: description, `dependsOn`, `defaultEnabled`, page prefixes and API prefixes (mark public ones), record kinds, webhook events, grants, MCP and API key scopes, search sections, owned message statuses, queue message types, cron tasks, Activity labels, reason texts and admin notes. Add it to `MODULE_MANIFESTS` in `src/lib/modules/registry.ts`. The manifest must not import `@/db`, zod, React or server code.
4. **Schemas.** Create `src/lib/modules/<id>/schemas.ts` with a zod input schema (and usually an output schema) for every capability. Use `resolveRefsSchemas` from `src/lib/modules/shared-schemas.ts` for record resolution.
5. **Descriptors.** Create `src/lib/modules/<id>/capabilities.ts` with the module's `promptFragment` (or `null`) and one descriptor per capability, built with `describeCapability`, which generates the JSON Schema from the zod schema. A descriptor names its surfaces (`assistant_tool`, `mcp_tool`, `search`, `resolve_refs`, `suggestion_kind`, `triage_step`, `action`, `webhook_event`, `lifecycle`, `cron`, `queue`, `jmap_capability`, `jmap_method`, `service`), the grants it needs, its effect and, where it applies, `mailboxBound` and `timeoutMs`. Add the list to `MODULE_CAPABILITIES` in `src/lib/modules/capability-registry.ts`.
6. **Handlers.** Create `src/lib/modules/<id>/server.ts` exporting one handler per invokable descriptor, and add it to `SERVER_MODULES` in `src/lib/modules/server-registry.ts`, which only `invoke.ts` imports. A handler gets parsed JSON and the call context, never `env`, a database handle, a binding, a `Request` or a function. It may call `getEnv()` for its own tables. Keep the module directory to these four files and put the implementation under `src/lib/<id>/`. Module directories may not use `import()`.
7. **Core services.** Reach core through `moduleHost` (`src/lib/modules/host.ts`): `mail.send` (the normal send path, counted against the acting user's send limits), `mail.getMessage`, `mail.readAttachment`, `mail.importMessages`, `emitWebhook`, `resolveRefs`, `invoke` (another module's `service`), `modules.isEnabledFor`, `users.getProfile` and `audit`. Never import `@/lib/email/send` or `@/lib/email/webhooks` from a module directory.
8. **Record kinds.** Add each `<id>:<type>` kind to `RecordKind` and to the manifest's `recordKinds`, with the neutral label shown when a record is unavailable. Declare a `resolveRefs` capability and put the resolver in `src/lib/<id>/refs.ts`. A resolver returns a same-origin `href` (or `null`) and a label, and must not reveal records the viewer cannot see.
9. **UI commands and client code.** Commands go in the client data with an effect (`navigate`, `read`, `fill`, `create`, `update`, `delete`) and either a route target (an href template filled from `params`) or a client target naming a handler. Client pieces (command handlers, suggestion cards, composer slots) go in `src/components/modules/<id>/client.ts`, registered in `MODULE_CLIENTS` in `src/components/modules/client-registry.ts` with the inline `typeof window` check at the `import()`, so the chunk stays out of the server bundle and loads only when a module that is on needs it.
10. **Composer slots.** Declare a `send-menu` slot in the client data and the manifest, and export `composerSlots[<slot id>]` with a `MenuItem` (and optionally an `Overlay`) from the client chunk. The composer loads the chunk only when its send menu is first opened and only for modules that are on.
11. **Queue and cron.** Declare queue message kinds in `queueMessageTypes` (kind, queue, capability, metric class) with a matching `queue` descriptor, and scheduled work in `cronTasks` with a matching `cron` descriptor. `dispatchModuleQueueMessage` and `runModuleCronTasks` in `src/lib/modules/background.ts` route them on both runtimes. A message for a module that is off is acked and skipped with `module_disabled`. Never add per-module code to `worker.ts`, `worker-utils.ts`, `server/index.ts` or `server/runtime/scheduler.ts`.
12. **Guards.** Give the module's pages their own route group and gate them with `requireModulePage(id)` in that group's outermost layout, which then renders the shell (see `src/app/(booking)/layout.tsx`). A guard in a layout nested inside a shell still shows the not-found page, but the Node build answers it with HTTP 200, and `tests/module-route-guard.test.mjs` refuses it. Gate each public page with `requirePublicModulePage(id, host)`. Wrap every exported method of every route under the module's API prefixes in `withModule(id, handler)` from `src/lib/modules/route-guard.ts`, and call `checkUser(user)` (or `checkHost` on a public route) right after authenticating. After adding routes, run `npm run docs:generate` and commit the result.
13. **Tests.** The unit tests in `tests/module-registry.test.mjs`, `tests/module-imports.test.mjs`, `tests/module-route-guard.test.mjs` and `tests/module-capabilities.test.mjs` check the new module automatically: manifests are data, descriptors round-trip through JSON, every descriptor has a handler, schemas match, routes are wrapped and core does not import module code. Add unit tests for your handlers, and add the module to `e2e/27-modules.spec.ts`: off hides its navigation, makes its pages not-found and its API 404, and on restores everything. Restore every module in `finally`.
14. **Data and backups.** Put the module's tables in their own schema file under `src/db/schema/`, write the migration by hand in the generated style, and add every new table to the backup lists in the same change (`BACKUP_TABLES` and `INTERNAL_TABLES` in `src/lib/backups/export.ts`, `BACKUP_TABLE_GROUPS` in `src/lib/backups/table-groups.ts`, `DatabaseBackupTable` in `src/lib/backups/types.d.ts`). A missing table must read as "nothing yet", so the module keeps working on a database that has not applied the migration.

Sandboxed apps (signed bundles that run inside your own Kite, using the same descriptors and the same call contract) are designed in the spec but not built.
