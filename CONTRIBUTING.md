# Contributing to Kite

Thanks for your interest in improving Kite. Bug reports, fixes, documentation and features are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so the approach can be agreed before you spend time on it.
- Security problems must not be reported in public issues. See [SECURITY.md](SECURITY.md).
- By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node.js 22 or newer and npm.

```bash
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev                    # http://localhost:3000
npm run db:seed                # optional sample data, with the dev server running
```

The self-hosted Node runtime can be run with `npm run dev:node`. See [docs/deployment.md](docs/deployment.md) and [docs/self-hosting.md](docs/self-hosting.md) for configuration, and [CLAUDE.md](CLAUDE.md) for an overview of the architecture.

## Checks

Every pull request must pass the same checks CI runs:

```bash
npm run check                  # typecheck + lint + tests
npm run build                  # vinext build of the Worker
```

- `npm run typecheck` must report no errors.
- `npm run lint` must report no errors. Do not add blanket `eslint-disable` comments; if a rule genuinely does not apply to a line, disable that one rule on that line and say why.
- `npm run test` runs the `node:test` files in `tests/`. Add tests for new pure logic there. They must not need Workers bindings; anything that needs D1 or R2 belongs in a script under `scripts/` run against `npm run dev`.

An optional pre-commit hook checks documentation and the formatting of staged files. It is not installed automatically; run `npm run hooks:install` to enable it (see [docs/quality.md](docs/quality.md#pre-commit-and-release-notes) for how it scopes `core.hooksPath` across worktrees). Without it, run `npm run precommit:check` before committing. CI runs every check either way.

## Code conventions

- Indent with tabs. `@/*` maps to `src/*`.
- Split non-trivial types and pure helpers out of components and modules into sibling `*-types.d.ts` and `*-utils.ts` files.
- Server code reaches platform bindings through `getEnv()` in `src/lib/cloudflare.ts` and the database through `getDb(env)` from `src/db`.
- API routes return `NextResponse.json({ error: "..." }, { status })` on failure.
- Write comments only where the reason behind the code is not obvious from the code itself.

## Database changes

- Schema lives in `src/db/schema/index.ts`. Migrations are SQL files in `drizzle/migrations/` with an entry in `drizzle/migrations/meta/_journal.json`.
- Any migration that creates, renames or removes a table must also update the backup and restore lists described in [AGENTS.md](AGENTS.md), and older backups must remain restorable.

## Commits and pull requests

- Use commit messages in the form `type(scope): summary`, for example `fix(compose): keep attachments when switching sender`. Common types are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore` and `ci`.
- Keep pull requests focused on one change and describe what it does and how you tested it. Include screenshots for visible UI changes.
- Each pull request gets an advisory PR report (`.github/workflows/pr-report.yml`) as a comment marked `<!-- kite-pr-report -->` and in the workflow step summary: Semgrep and npm audit findings, new quality debt, coverage and warnings when a table change skips the backup lists, UI changes have no e2e change, or a Cloudflare resource name changes. It is not a required check; fork pull requests get the step summary only. See [docs/quality.md](docs/quality.md#pr-report).
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for user-visible changes. Maintainers turn those entries into a release as described in [docs/releasing.md](docs/releasing.md).

## License

Kite is licensed under the GNU Affero General Public License v3.0. By submitting a contribution you agree that it is licensed under the same terms.

## Naming conventions

These rules apply to the application and the email relay:

- Use `camelCase` for functions, variables and properties, and `PascalCase` for React components, classes and TypeScript types.
- Use `kebab-case` for source filenames; keep framework entrypoint names such as `route.ts`, `page.tsx` and `index.ts`. Tests use `*.test.mjs` or `*.spec.ts`; declaration files use `*.d.ts`/`*.d.mts`.
- Use descriptive domain names rather than abbreviations. Name structured log events with a stable lowercase component and action, such as `relay.request_failed`.
- Preserve established external contracts: Cloudflare bindings/resource names, `X-Kite-*` headers and the accepted `X-Mailflare-*` ones, calendar UIDs, localStorage keys and database table names. Naming cleanup never changes a public identifier without an explicit migration plan.

`npm run test:list` lists browser scenarios and skips all relay test bodies while registering their names. The Node discovery command imports the relay test modules, so use it only for this trusted test corpus; it is not a sandbox for arbitrary tests.
