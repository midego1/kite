# Agents SDK spike: keep the kite-agent queue

Automatic reading needs a background job per inbound message: claim it once, check gates, call a model, write suggestions, notify. Before building it we compared two ways to run that job:

1. The Cloudflare Agents SDK (`agents` 0.28.0): one Durable Object per agent (for example one per mailbox), with its own SQLite storage, `this.queue()` / `this.schedule()` for background work, and built-in retries.
2. Extending what Kite already has: `agent_jobs` rows in D1, the `kite-agent` queue (`AGENT_QUEUE`), and the lease in `processAgentDraftJob` (`src/lib/agent/jobs/utils.ts`), with a new `agent.triage` message kind.

Research used `npm view` and a throwaway install in a temp directory outside the repo. `agents` was never added to `package.json`.

## Both runtimes

Kite runs on Workers and on Node (`server/index.ts`, Docker). Application code must not care which one it got.

- **Queue:** already works on both. On Workers `AGENT_QUEUE` is a Cloudflare Queue; on Node it is the in-process SQLite-backed queue from `server/runtime/env.ts`, consumed by `runtime.agentQueue.setConsumer` in `server/index.ts`. Adding a kind is one branch in each consumer.
- **Agents SDK:** an `Agent` is a Durable Object. Node has no Durable Objects. The bundle imports `cloudflare:workers` and `cloudflare:email`, and agent state lives in the object's own SQLite storage, alarms and `ctx`. The only stand-in Kite has today is the realtime hub (`server/runtime/realtime.ts`), which fakes WebSocket fan-out, not storage, alarms or the SDK's lifecycle. Supporting Node would mean either writing and maintaining a fake Agent runtime or keeping a second, queue-based implementation for Node. Both defeat the point.

## Bundle budget

Budgets are in `scripts/quality/bundle-budgets.json` and checked by `npm run quality:report`. The worker budget is 5,101,006 B raw / 1,439,860 B gzip; the last local build measured 4,534,236 / 1,282,650, leaving about 567 KB raw and 157 KB gzip.

A minimal Agent (one class, one `this.queue()` call, `getAgentByName` routing), bundled with esbuild and minified, came to **1,194,754 B raw / 276,293 B gzip**. That is about twice the remaining headroom, before any Kite code is added. The install is 169 packages and 113 MB of `node_modules`. The queue approach adds no dependency and only the triage code itself.

## Lease and idempotency

The existing design already gives the guarantees automatic reading needs, all in D1 next to the data they protect:

- `agent_jobs` has a unique index on the source message (extended in migration 0060 to `(mailbox_id, source_message_id, kind)`), so a redelivered inbound message cannot create a second job.
- The claim is one conditional `UPDATE … WHERE status = 'pending' OR lease expired … AND NOT EXISTS (another running job for this mailbox)`. It sets a 10-minute lease, so jobs for one mailbox run one at a time and a crashed worker's job is picked up again.
- Retries use `attempts` and `next_attempt_at` (3 attempts, backoff up to 60 s), and cron recovery (`recoverAgentDraftJobs`) re-runs due and expired jobs.
- The new `agent_actions` table records each side effect before it happens, and spend reservation is a conditional `INSERT … SELECT` on `ai_usage`. Both depend on joins with `messages`, `mailboxes`, `ai_usage` and `mailbox_agent_settings` in the same database.

A Durable Object per mailbox would also serialise work, but its queue rows and retry counters (`maxAttempts: 3` by default) live in the object's private SQLite. Kite would still need `agent_jobs` in D1 for the admin job list, retry endpoint, daily limits and backups, so there would be two sources of truth for one job. Install-wide checks (the daily spend cap across all mailboxes, the kill switch) cannot run inside a single mailbox's object anyway.

## Peer dependencies

`agents` 0.28.0 has three required peers: `@modelcontextprotocol/sdk` 1.30.0, `@modelcontextprotocol/client` 2.0.0 and `@modelcontextprotocol/server` 2.0.0, all pinned to exact versions. Kite already depends on `@modelcontextprotocol/server` ^2.3.1 (installed 2.3.1) for its own MCP endpoint. A dry-run `npm install agents@0.28.0` against copies of Kite's `package.json` and `package-lock.json` fails with `ERESOLVE` on that peer. Adopting the SDK today means downgrading the MCP server package or forcing `--legacy-peer-deps`, plus two more MCP packages Kite does not use. Its other peers (`ai`, `zod`, `react`, `vite` and others) are optional and compatible with what Kite has.

## Migration cost

Queue:

- One new message kind in `env.d.ts`, `worker.ts`, `server/index.ts` and `worker-utils.ts`.
- `kind` filters on the existing job queries.
- One D1 migration (0060), already written.
- No change to `wrangler.jsonc`, deploy steps or backups beyond the new tables.

Agents SDK:

- A new Durable Object class exported from `worker.ts`, plus a `new_sqlite_classes` migration and binding in both places `wrangler.jsonc` declares Durable Objects. This is a deployed-resource change that existing installs pick up on their next deploy and that cannot be cleanly removed later.
- A Node stand-in or a second Node implementation.
- Resolving the MCP peer conflict.
- Moving or duplicating job state between D1 and Durable Object storage.
- Rewriting the existing auto-draft job on the new model, or running two job systems side by side.
- The backup and restore story for state in Durable Object storage, which the D1 JSON backup does not cover.

## Decision

Keep the `kite-agent` queue and add `agent.triage` jobs to it. The SDK is not clearly better on any of the criteria. It fails the Node runtime requirement, exceeds the bundle headroom on its own, conflicts with an installed dependency, and duplicates a lease and idempotency design Kite already has in D1.

Revisit if any of these change:

- Kite drops the Node runtime.
- A feature needs long-lived per-mailbox state or a live connection (for example a streaming chat agent per user) that D1 plus the realtime hub cannot serve.
- `agents` relaxes its exact `@modelcontextprotocol/*` pins to ranges that include Kite's versions.
- The minimal Agent bundle fits in the worker budget with room to spare.

## PR summary

Agents SDK spike (`docs/notes/agents-sdk-spike.md`): we keep the existing `kite-agent` queue for automatic reading.
`agents` 0.28.0 is Durable Object based, so it cannot run on the Node/Docker runtime. A minimal Agent adds about 1.19 MB raw / 276 KB gzip, roughly twice the remaining worker bundle headroom.
Its exact `@modelcontextprotocol/server` 2.0.0 peer conflicts with Kite's 2.3.1 (`npm install` fails with `ERESOLVE`).
The D1 `agent_jobs` lease, unique source index and write-before-effect `agent_actions` already give the needed idempotency on both runtimes.
