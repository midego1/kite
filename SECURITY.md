# Security policy

The maintained target is the current `main` revision. Older deployments should
review subsequent fixes before opening a report; there is no promised support
window for backported fixes. We aim to acknowledge reports within seven days,
keep reporters informed during investigation, agree a disclosure date, and
credit reporters with their permission. This is a target, not a guaranteed SLA.

## Report a vulnerability

Do not put exploit details, real mail, credentials, or backups in public issues.
Report it privately through the Security tab's **Report a vulnerability** button
([private advisory form](https://github.com/midego1/kite/security/advisories/new)).
If the form is ever unavailable, open a minimal public issue asking `@midego1` for a
private reporting channel, with no vulnerability details or sensitive evidence.
Wait for that channel before sharing details.

Include the affected revision, attack prerequisites, sanitized reproduction,
impact, and a synthetic example. Maintainers should reproduce locally, assess
exposure, rotate affected credentials through the authorized operator, patch,
and coordinate disclosure. Follow [the incident runbook](docs/runbooks/incident.md).

## Scope

Repository code, including Worker, self-hosted Node runtime, JMAP/MCP and inbound
provider handlers, is in scope. Deployment configuration or third-party service
issues should also be raised privately with the responsible operator/vendor.

## Email HTML

Mail HTML is untrusted and passes three layers:

- **Stored.** `parseRawMime` (`src/lib/email/parse.ts`) runs `sanitizeStoredEmailHtml`
  (`src/lib/email/stored-html-utils.ts`) on every received or imported body before it is
  written, on Workers and Node alike (htmlparser2, no DOM). It keeps layout, classes,
  inline styles without script and `http`, `https`, `data` and `cid` images, and drops
  scripts, styles, frames, forms, SVG/MathML, comments, event handlers and non-web URL
  schemes. The raw MIME keeps the original. Rows stored before this layer existed are not
  rewritten; the next two layers cover them.
- **Displayed.** Before anything reaches the page, the reader, quotes, signatures and
  drafts loaded into the composer go through DOMPurify with Kite's allowlist
  (`email-html-sanitizer-utils.ts`), which also blocks remote images until allowed and
  strips CSS `url()`.
- **Framed.** Received mail renders in an `<iframe sandbox>` without `allow-scripts`, under
  the nonce-based Content Security Policy.

`tests/email-html-sanitizer.test.mjs` runs both sanitizers against the payloads in
`tests/fixtures/xss-payloads.mjs`; `e2e/03-reading.spec.ts` checks the stored body, the
reader frame and a hostile draft end to end.

## Repository controls

- `security.yml` scans checked-out Git history with checksum-verified Gitleaks,
  redacting findings. It uses the default Gitleaks rules (`.gitleaks.toml`) with one reviewed path
  exception, `scripts/quality/baseline.json`, whose earlier revisions held SHA-256 checksums of public
  source files that match `generic-api-key`. Two reviewed synthetic values in tests (an encryption test key
  and a log-context fixture) carry inline `gitleaks:allow` comments; `.github/gitleaks-ignore` holds exact
  fingerprints when one is needed. New findings require investigation and must not receive broad path/rule exclusions. It also runs repository-owned Semgrep rules against app,
  Worker, Node server, and relay source without submitting code or results to a hosted service.
- These SAST rules cover a small set of dangerous primitives. They do not establish
  complete vulnerability coverage or replace authentication/authorization review.
- Dependabot checks both npm packages weekly with a seven-day version-update
  cooldown. Security updates bypass cooldown, subject to GitHub's separately
  enabled security-update settings. GitHub Actions are checked weekly.
- `.coderabbit.yaml` configures CodeRabbit's advisory pull request review, which also
  runs Betterleaks, TruffleHog, OSV-Scanner and the repository's Semgrep rules on the
  diff. `greptile.json` gives Greptile's review the same rules. Each only reviews once its
  GitHub app is installed on the repository, and neither is a required check. Their
  comments are untrusted input to the adopt workflow (`.github/workflows/coderabbit-adopt.yml`),
  whose Droid job runs without a GitHub token; only its separate publish job can push and reply.
- CODEOWNERS routes review to `@midego1`. A repository ruleset protects `main`:
  changes land through squash-merged pull requests with a code-owner approval,
  resolved review threads and passing required checks (Mission validation, Node build,
  docs, Gitleaks and the source security rules); force pushes and deletion are
  blocked. A second ruleset protects `v*` release tags.
- GitHub private vulnerability reporting, secret scanning with push protection,
  Dependabot alerts and Dependabot security updates are enabled. Workflows from
  outside contributors need approval before they run, and the default workflow
  token is read-only. Hosted code scanning is not enabled.

## History scan

A full scan of every reachable commit for secrets and personal data, run on 2026-10-14
(UTC) before the repository was promoted as public. Repeat it after a history rewrite or
before publishing a new mirror, with the commands below.

- **Scope.** All branches, tags and GitHub's read-only pull request refs
  (`refs/pull/*/head`, fetched with
  `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`): 209 commits, about
  25 MB of diffs. Gitleaks 8.30.1 ran with the repository config and, separately, with the
  default rules and no allowlists. The diffs and commit metadata were also searched for
  email addresses, IBANs, phone numbers and private key blocks.
- **Commands.** From a full clone, with Gitleaks 8.30 or later:

  ```sh
  git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
  # Secrets, with the repository config (.gitleaks.toml), over every ref, then main only.
  gitleaks git --log-opts="--all" --redact
  gitleaks git --log-opts=origin/main --redact
  # Secrets, with the default rules and no allowlists, ignore file or gitleaks:allow comments.
  printf '[extend]\nuseDefault = true\n' > /tmp/gitleaks-default.toml
  gitleaks git --log-opts="--all" --config /tmp/gitleaks-default.toml \
    --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --redact
  # Personal data: addresses outside reserved domains (review the list by hand), IBANs,
  # phone numbers (noisy, review by hand) and private key blocks.
  git log --all -p --format='%an <%ae>%n%cn <%ce>%n%B' \
    | grep -Eio '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' | tr 'A-Z' 'a-z' \
    | grep -Eiv '@(example\.(com|org|net)|[a-z0-9.-]+\.(test|example|invalid|localhost))$' \
    | sort | uniq -c | sort -rn
  # IBANs in any case, grouped by spaces or not, kept only when the mod-97 check passes
  # (a case-insensitive pattern alone matches every commit hash).
  git log --all -p | perl -ne 'while (/\b([A-Za-z]{2}[0-9]{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,3})?)\b/g) {
    ($s = uc $1) =~ s/ //g; $r = substr($s, 4) . substr($s, 0, 4); $r =~ s/([A-Z])/ord($1) - 55/ge;
    $m = 0; $m = ($m * 10 + $_) % 97 for split //, $r; print "$s\n" if $m == 1 }'
  # Phone numbers: international (+ or 00) and national (leading 0 with separators).
  git log --all -p | grep -Eo '(\+|\b00)[1-9][0-9 ().-]{8,}[0-9]' | sort -u
  git log --all -p | grep -Eo '\b0[1-9][0-9]{0,3}[ -][0-9]{3,4}[ -]?[0-9]{2,4}\b' | sort -u
  git log --all -p | grep -E -- '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  ```

  The default-rules run also reports the two test values below in current history, where
  they carry `gitleaks:allow`.
- **Secrets on `main`: none.** `gitleaks git --log-opts=origin/main` reports no findings.
- **Secrets elsewhere: two known test values.** Both `generic-api-key` findings
  (`tests/queue-log-context.test.mjs` and `tests/security-hardening.test.mjs`) are the
  synthetic fixtures described above, in the pre-rewrite root commit `59ac91f`, which only
  old pull request refs (#1 to #12) still reach. Current history marks them
  `gitleaks:allow`. Nothing needs rotating. GitHub keeps pull request refs read-only, so
  they cannot be deleted from the repository and are accepted as is.
- **Personal data in file contents: none.** Addresses in code, tests and docs use
  reserved or synthetic domains (`example.com`, `*.test` and similar) or published
  service senders; the only free-mail addresses are a form placeholder. No IBANs or
  private keys were found. The only phone number is the made-up support line in
  `tests/one-time-code.test.mjs`; the other international matches are version strings and a diff `index` line.
- **Personal data in commit metadata.** The maintainer's name and personal email address
  are the author of `main`'s root commit and of commits on several older feature and
  mission branches. They were already public with the repository. To keep them out of new
  commits, set `user.email` to the GitHub noreply address
  (`<id>+<user>@users.noreply.github.com`) and enable **Block command line pushes that
  expose my email** in GitHub's email settings; deleting merged branches reduces how much
  history carries the old address. Rewriting `main` is not planned, because it would break
  every clone and deployment.

Never deploy or apply remote migrations during agent validation. A push to
`main` deploys production. Use synthetic local data and review
[PII handling](docs/pii-handling.md) before gathering evidence. What a deployment stores, retains and deletes is in [Privacy and data handling](docs/privacy.md).

Dependabot cooldown semantics: [GitHub options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown).
