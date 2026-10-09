---
name: validate-kite
description: Validate a Kite mission branch locally with synthetic data and report evidence before human review.
---

Read `AGENTS.md`, `docs/mission-readiness.md`, `SECURITY.md`, and
`docs/pii-handling.md` first. Stay on `mission/*` or `feature/*`.

1. Use Node 22.21+ and `npm run setup:mission` when dependencies are absent.
2. Run `npm run check:mission`. Fix failures and rerun affected checks.
3. Run `node scripts/docs-check.mjs`; regenerate with
   `node scripts/docs-generate.mjs` when API route exports change, and review
   `docs/api.md` for semantic documentation updates.
4. For persisted table changes, verify backup/restore lists and groups as
   required by AGENTS.md. For UI changes cover Kite, Classic and dark mode.
5. Report actual commands, pass/fail results and remaining limits. Attach only
   synthetic evidence. Do not claim a Factory readiness score without a new
   external assessment of the intended revision.

Never push to main, deploy, run remote migrations, rename Cloudflare resources,
collect real user data, or configure external accounts. Human review and merge
are required. A failed lane is unfinished work, not a reason to waive checks.
