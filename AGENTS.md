# Repository agent instructions

## Branches and deploys

- A push to `main` deploys to production through the Cloudflare Git integration. Never push to `main` from automated or mission work. Work on a branch named `mission/<topic>` (or `feature/<topic>`), push only that branch, and leave merging to a human.
- Never run `npm run deploy`, `npm run db:migrate:remote`, or any `wrangler ... --remote` command.
- Do not rename Cloudflare resource names (Worker and D1 `kite`, R2 `kite-raw`, queues `kite-*`, dataset `kite_metrics`). Installs from before the rename to Kite still depend on the old names in a few places, so keep that compatibility: the server accepts `X-Mailflare-*` relay headers and `X-Mailflare-Forwarded`, calendar UIDs keep the `@mailflare` suffix, `mailflare-*` browser keys are moved on first load, `mailflare-database-backup` documents restore, and the HKDF info string in `src/lib/security/secret-box.ts` and the AWS SES resource names never change. User-facing text says Kite.

## How to test

Run these before calling any change done, and fix failures first:

1. `npm run check`: app and relay typechecks, lint, app unit tests (`tests/*.test.mjs`) and relay handler tests (`deploy/cloudflare-email-relay/tests/*.test.mjs`, no production bindings).
2. `npm run build`: the vinext Worker build (it does not type-check; step 1 does).
3. `npm run build:node`: the Node/Docker build. `next build` type-checks and rejects React hooks in modules a Server Component imports, which the vinext build does not catch.
4. `npm run test:relay:integration`: actual local workerd relay → local HTTP receiver, HMAC and store/reject checks; synthetic mail only.
5. `npx playwright test`: the end-to-end suite in Chromium. It starts its own dev server on port 3200 with an isolated database (`.wrangler/e2e-state`), seeds an admin (`admin@example.com` / `demo-password-change-me`) and 15 messages, and needs no Cloudflare credentials. Run one file with `npx playwright test e2e/<file>.spec.ts`. See `e2e/README.md`.

Pull requests also get an advisory report comment (`.github/workflows/pr-report.yml`, `node scripts/review/pr-report.mjs --base origin/main --inputs test-results` locally) that warns about table changes without backup list updates, UI changes without e2e changes and changed Cloudflare resource names. Add or update an e2e spec for every user-visible behaviour change. For manual checks, `npm run dev` serves the app on port 3000 with its own local state; `npm run db:seed` fills it with the same demo data.

For a fresh Mission worker, run `npm run setup:mission` (or open `.devcontainer`). Installing never changes Git configuration; `npm run hooks:install` enables the optional pre-commit hook. Run every required check with `npm run check:mission`. See `docs/mission-readiness.md` for relay QA and structured logging.

## UI conventions

- Two styles share one codebase: Kite (default) and Classic, switched by `data-style` on `<html>` (sidebar toggle, Settings → Appearance). Components use Tailwind's `blue-*` palette, which `src/app/globals.css` remaps to Kite indigo; keep using `blue-*` rather than hard-coded hex so both styles and dark mode work. Check new UI in Kite, Classic and dark mode.
- Per-browser preferences (font, text size, assistant layout) go through `src/components/appearance-preferences.ts`.

## Database backup and restore

- Whenever a migration creates, renames, or removes a persisted table, update the backup and restore table lists in the same change, even if the feature is unrelated to backups. Review `BACKUP_TABLES` and `INTERNAL_TABLES` in `src/lib/backups/export.ts`, `BACKUP_TABLE_GROUPS` in `src/lib/backups/table-groups.ts`, and `DatabaseBackupTable` in `src/lib/backups/types.d.ts`.
- Put every backed-up table in exactly one group. Keep `BACKUP_TABLES` in foreign-key dependency order so restore inserts parents before children and deletes them in reverse order. Exclude a table only when its contents are derived or internally managed, and document why.
- When adding a table, check backup and restore behavior both before and after its migration is applied. Keep older full backup documents restorable.
