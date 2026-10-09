## Problem and resulting behavior

Describe the trigger, previous behavior, and result. Link the issue, if any.

## Validation

Record the commands actually run and results; explain any skipped lane.

- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm run test:relay:integration`
- [ ] `npx playwright test`
- [ ] `node scripts/docs-check.mjs`

## Review considerations

- [ ] User-visible changes have browser coverage in Kite, Classic, and dark mode.
- [ ] Persisted table changes update backup/restore lists and table groups.
- [ ] API route changes regenerate `docs/api-inventory.md` and update `docs/api.md` when behavior changes.
- [ ] Logs, screenshots, fixtures, and issue evidence contain only synthetic data.

Describe migrations, compatibility, rollout and rollback considerations when relevant.
A merge to `main` deploys production; a human must review and merge.
