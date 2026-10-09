# Mission development and validation

Use Node **22.21 or newer**. The main application and the Cloudflare email
relay are both part of this repository's validation contract.

## Prepare an isolated worker

Open the repository in the `.devcontainer` configuration, or run:

```sh
npm run setup:mission
```

This installs locked application dependencies, generates the migration bundle,
and installs Chromium with its host dependencies. On Linux, browser system
package installation may need administrator privileges. No Cloudflare account
or production secrets are needed for the checks below.

## Validate a change

```sh
npm run check:mission
```

This runs app and relay typechecks, ESLint, app unit tests, relay handler tests,
the Worker build, the Node/Docker build, a relay integration check in real local workerd, and the
Chromium end-to-end suite. CI runs the same lanes on pull requests, with `build:node` in a parallel "Node build" job (`MISSION_SKIP_TASKS=build:node` on the Mission validation step; locally nothing is skipped). Keep all
lanes passing before handing a branch to another worker.

The browser suite starts its own server on port 3200 and resets only its
`.wrangler/e2e-state` database. See [the browser QA guide](../e2e/README.md)
for seeded users, coverage, assertions, and interactive Playwright commands.

## Relay QA

The relay has no browser UI. Its interactive surface is inbound email, so use:

```sh
npm run test:relay
npm run test:relay:integration
```

The first command exercises signing, payload limits, store/reject/forward
routing, network errors and forwarding errors against controlled dependencies.
The second launches the actual relay with local workerd and an ephemeral HTTP
receiving server. It injects synthetic MIME through Miniflare's email trigger,
checks the envelope-bound HMAC and raw body at the receiving server, and checks
that both storage and routing rejection flow through the runtime. It chooses
available ports and shuts down both servers. It neither sends real mail nor
contacts production. Its local runtime state is `.wrangler/relay-qa`.

For manual inspection, `npx playwright test --ui` opens the app QA runner.
For relay scenarios, edit the synthetic message and response in
`scripts/relay-smoke.mjs`, then rerun the local integration command. The relay's
standalone directory also offers `npm test` and `npm run check` after its own
`npm install`; the root validation is preferred because it uses the committed
application lockfile and covers both packages.

## Structured logs

Worker email/queue/backup failures, self-hosted queue/scheduler failures and
relay failures use `src/lib/logger.mjs`. Each line is JSON with `timestamp`,
`level`, `component`, `event`, and operational `fields`. `LOG_LEVEL=debug`
enables debug entries on local Node processes; the development container sets
it. Production defaults to `info`.

Pass only operational metadata such as retry counts and message IDs. The
logger redacts sensitive field names recursively and reduces exceptions to
an error type plus a code-shaped `code` (for example `ECONNRESET`), avoiding
exception messages/stacks that may contain email or credentials. Do not pass
email content or credentials in ordinary fields.

Queue failures (`queue.processing_failed` on Workers, `queue.job_failed` and
`queue.retries_exhausted` on Node) carry `queue`, `messageId`, `attempts`,
the message `kind` (`inbound`, `webhook_retry`, `outbound`, `agent_draft`,
`import`, `mailbox_purge` or `unknown`) and, for inbound mail, the
`rawR2Key` of the stored MIME (`inbound/<timestamp>-<id>.eml`).
`inbound.enqueue_failed` carries the `stage` the email handler reached
(`route`, `read_raw`, `forward`, `store`, `enqueue`), `rawSize` and the
`rawR2Key` once written. None of these contain addresses.

`http.request_completed` is written only when a request needs attention:
`error` for status 500 and above, `warn` with `slow: true` for requests over
1000 ms, and `info` for 4xx. Fast successful requests are not logged; thrown
errors produce `http.request_failed`. Every `/api/` response still carries a
`traceparent` header.

## Factory report

Open **Agent Readiness → mailflare** to view the report; the Mission dialog's
report shortcut may fail even while GitHub is connected. After these changes
are merged, refresh/re-run the readiness assessment against the merged
revision. Factory's score is an external assessment, so a local passing run
alone does not establish a new score.

A push to `main` deploys the app. Mission workers must use `mission/*` branches
and leave merges to a human, as required by `AGENTS.md`.
