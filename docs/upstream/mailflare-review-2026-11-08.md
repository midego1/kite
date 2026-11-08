# Upstream Mailflare review — 2026-11-08

Kite is a fork of [hieunc229/mailflare](https://github.com/hieunc229/mailflare) (AGPL-3.0, same
license as Kite, so anything adapted stays compatible and keeps its attribution in `NOTICE`).
This reviews every commit on upstream's `main` since our last port, [#257](https://github.com/midego1/kite/pull/257)
/ [#258](https://github.com/midego1/kite/pull/258) (`bc37e2a9`, `6eb52c9`, merged 2026-10-31), which
carried upstream through its commit `1302bbae7d` (PR #226). Upstream's own `#214`–`#226` security
batch, including `#215` and `#216` which our commit titles didn't call out explicitly, is fully
accounted for — `NOTICE` and commit `de410cc` (Kite PR #241) confirm `#215`/`#216` landed too.

Upstream `main` is at `d4dc8337` (2026-11-06) as of this review: **22 commits** in
`1302bbae7d..main`, **17 of them merged PRs** (`#228`, `#229`, `#231`, `#235`, `#241`, `#242`,
`#243`, `#245`, `#249`, `#250`, `#251`, `#252`, `#255`, `#256`, `#260`, `#261`, `#262`; `#101` and
`#205` are issue numbers two of those PRs also reference, not separate PRs), and 5 direct-to-`main`
commits with no PR (a version bump, a changelog archive, one UI tweak, a PR template, and a no-op
merge). No code is ported in this document; this is the triage, matching the format of our previous
rounds (`144ecb5`, `8a62d59`, `a60ab79`, `5e656cc`, `9134846`, `bc37e2a9`, `6eb52c9`).

Ordered security-relevant items first, then correctness bugs, then performance/reliability, then
feature gaps, then UI polish, then items we already have or that don't apply — in that order, not
mixed.

## A. Security-relevant

### 1. No user-facing warning for a spoofed sender, even though Kite already computes the signal

**Upstream:** `cd4210b` — "show sender details and surface authentication warnings" (#228).

**What it does:** A message-level warning for failed authentication, a spoofed display name,
cross-domain Reply-To, and an unaligned DKIM signature, plus a compact thread badge and an inline
sender-identity/authentication details panel, with cached authentication results reused rather than
re-checked. Seeds demo messages (trusted/failed/untrusted delivery) so the view is exercisable
locally.

**Does Kite have it or an equivalent?** No UI for it, but most of the hard part is already built.
Kite's spam engine (`src/lib/spam/engine.ts`) computes exactly this class of signal today —
`authPassed`, `fromMayBeForged`, `planAuthPolicy`, DMARC/SPF/DKIM alignment — and stores it per
message in `messages.spam_signals` (see `CLAUDE.md`'s "Spam analysis" section). None of it reaches
the reader UI unless the message crosses the spam threshold: a message that lands in the Inbox today
shows nothing about a failed authentication check, a spoofed display name, or a cross-domain
Reply-To, even though Kite already has the data to say so.

**Applies to Kite?** Yes, and arguably more cleanly than to upstream — Kite doesn't need to build new
detection, just a UI surface over signals it already stores.

**Recommendation: adapt.** This is a genuine gap worth proposing as its own small feature (reading
`messages.spam_signals` into a compact details panel/notice in the reader), not copying upstream's
detection code — Kite's detection is already more developed. Worth prioritizing: it's the one
finding in this round with a direct anti-phishing/user-safety angle.

### 2. Sender-identity parsing: escaped quotes break address extraction

**Upstream:** `e7d2146` — "parse display names with escaped quotes or backslashes" (#250).

**What it does:** `formatEmailAddress` quotes a display name and escapes `"` and `\`, so a sender
named `Maya "MJ" Chen` is stored as `"Maya \"MJ\" Chen" <maya@example.com>`. The old parser's regex
didn't accept escapes inside the quotes, so `parseEmailAddressParts` returned the *entire header* as
the "address" instead of `maya@example.com`, and the list-splitter cut a name like `5\" Screens, Inc`
at the escaped quote's comma instead of treating it as one quoted token.

**Does Kite have it or an equivalent?** No — and it has the same bug, independently. Kite's
`parseNameAddr` (`src/lib/email/address.ts`) is a hand-written index-based parser rather than
upstream's old regex, but it has the identical blind spot: it finds the *first* `"` after position 1
with `indexOf('"', 1)`, which lands on the escaped quote inside the name, not the real closing quote,
and returns `null`. Verified directly:

```
formatEmailAddress("maya@example.com", 'Maya "MJ" Chen')
  -> '"Maya \\"MJ\\" Chen" <maya@example.com>'
parseNameAddr(that string) -> null   // falls back to { name: null, address: <the whole header> }
```

`getEmailAddress`, `normalizeEmailAddress` and `getEmailAddressList` all return the full raw header
instead of the real address. Those feed `src/lib/spam/engine.ts`, `reputation.ts`,
`phishing-report.ts` and `src/lib/contacts/*` — sender-identity matching (blocking, safelisting,
reputation, contact de-duplication) all key off the normalized address. A sender whose display name
happens to contain a quote (not unusual for business names) could be normalized to a garbage
"address" that never matches a block rule or an existing contact keyed by the real address.
`splitEmailAddressList` has the matching gap for commas inside an escaped-quote name.

**Applies to Kite?** Yes, directly — same vulnerability class, different implementation of the same
flawed idea (stop at the first literal `"`).

**Recommendation: adapt.** Port the concept (handle backslash-escaped quotes/backslashes before
treating a `"` as a closing delimiter, and skip escaped characters when splitting lists), written in
Kite's own index-based style rather than copying upstream's regex. Add the equivalent of upstream's
`tests/email-address-quoting.test.mjs` for `src/lib/email/address.ts`.

## B. Correctness bugs

### 3. Resend domain health check misreads its own published records

**Upstream:** `64274a6` — "accept Resend's actual published records in domain health checks" (#101) (#241).

**What it does:** Resend publishes its SPF record on `send.<domain>` or `rsend.<domain>`, never the
apex — the health check only looked at the apex, so a correctly configured Resend-sending domain
could show SPF as "missing". It also tightened the receiving MX check: trust Resend's own
`verified` status when given, and otherwise match by target shape (`isInboundSmtpMx`) rather than one
exact hostname.

**Does Kite have it or an equivalent?** No, and it has the identical bug. `src/lib/domains/dns-audit.ts`
checks SPF only at `hostname` (no Resend subdomain fallback — nearly line-for-line the pre-fix
upstream code), and `src/lib/domains/resend-receiving.ts:127` is
`const mxOk = mx ? await hasMx(env, domain, mx.value) : false;` with no "Resend already verified it"
shortcut and no fallback matcher when Resend names no inbound MX.

**Applies to Kite?** Yes, directly — Kite's Resend domain/DNS code is a close sibling of upstream's,
not meaningfully diverged here.

**Recommendation: adapt.** Port the `checkAny`/`spfNames` fallback into `dns-audit.ts` and the
`hasMxMatching` + "trust a verified record" logic into `receiving-dns.ts`/`resend-receiving.ts`. No
migration, isolated files, low risk.

### 4. Account creation rejects domains a mailbox manager is actually allowed to use

**Upstream:** `638a5e6` — "Fix account creation domain ownership for mailbox managers" (#255).

**What it does:** A secondary admin ("mailbox manager") created by another admin may already use
that creator's domains for mailbox creation, but account creation only accepted domains the acting
admin owns directly, so a manager saw the domain in the UI and got a 404 "Domain not found" trying to
use it.

**Does Kite have it or an equivalent?** Kite has the identical mailbox-manager delegation concept
(`canManageMailboxes` / `createdByUserId` on `users`) and the identical inconsistency: mailbox
creation (`src/app/api/mailboxes/route.ts:83`) already allows
`user.canManageMailboxes && user.createdByUserId && domain.userId === user.createdByUserId`, but
account creation's `getDomainForAdmin` (`src/app/api/accounts/utils.ts:30`) only checks
`eq(domains.userId, adminUserId)` — no delegation. Same bug, same two call sites out of sync.

**Applies to Kite?** Yes, directly.

**Recommendation: adapt.** Port the `domainOwnerIdsForAdmin`-style fix: extend `getDomainForAdmin`
(and the alias/duplicate-address checks that currently key off `adminUserId` alone) to accept the
delegated domain set, matching what mailbox creation already does. Not a security hole (it blocks
legitimate use rather than granting unauthorized access), but a real functional bug for any install
using mailbox managers.

### 5. GPT-5 and later OpenAI models don't get the Responses API

**Upstream:** `d231a0` — "Fix OpenAI assistant requests for modern GPT models" (#251).

**What it does:** Route GPT-5+ through OpenAI's Responses API (`provider.responses(modelId)`, with
`store: false`) so reasoning and function tools work together; keep older models on Chat Completions.

**Does Kite have it or an equivalent?** No. `src/lib/agent/model.ts` already special-cases Anthropic
(`createAnthropic`) but sends every other preset, including `openai`
(`PROVIDER_BASE_URLS.openai` exists in `provider-constants.ts`), through
`createOpenAICompatible(...).chatModel(modelId)` regardless of model version. An owner who points
Kite's "openai" preset at a GPT-5-class model would hit the same limitation upstream fixed.

**Applies to Kite?** Yes, same library (`ai-sdk`), same gap, and Kite's `model.ts` already has the
right shape (per-preset branching) to add this cleanly.

**Recommendation: adapt.** Add the same `gpt-\d+` version check and `responses()` branch inside the
existing `config.preset === "openai"` case, reusing Kite's own `gated()` wrapper. Needs the
`@ai-sdk/openai` dependency (currently Kite only has `@ai-sdk/openai-compatible` and
`@ai-sdk/anthropic`) — note that per `ROADMAP.md`'s "no new runtime dependency without a reason",
though the reason here (correct tool+reasoning behavior for a widely-used model family) is solid.

### 6. `queryDns` can return a CNAME alongside the requested record type — and it already shows in the DKIM display

**Upstream:** `8af747f` — "report only the requested record type from queryDns" (#249). An A/AAAA
lookup's DNS-over-HTTPS answer can include the first CNAME record alongside the requested type;
upstream found it via a public-IP validation failure on a CNAME-backed remote-image host.
`queryDns` returned every `Answer` entry with no type filter.

**Does Kite have it or an equivalent?** Yes, byte-for-byte: `src/lib/dns-query.ts`'s `queryDns` maps
every `Answer` entry with no type filter, identical to upstream's pre-fix code. Checked every
current caller: `src/lib/domains/dns-audit.ts`, `receiving-dns.ts`, `external-accounts/detect.ts`
and `spam/dmarc-policy.ts` only ever ask for `"MX"` or `"TXT"` — nothing asks for `"A"`/`"AAAA"`
today, so Kite doesn't hit upstream's exact failure mode (its SSRF-sensitive host checks in
`src/lib/security/outbound-url.ts`/`src/lib/net/host-guard.ts` resolve through the separate
`env.RESOLVE_HOST` Node binding, not this DoH path). But it **does already manifest** for DKIM: a
DKIM selector that's `CNAME`'d to another host (common for third-party ESPs) answers with the CNAME
target alongside the real TXT record; `dns-audit.ts`'s DKIM check accepts any answer
(`matches: () => true`), and `DomainDnsDetails.tsx:81` renders `item.found.join(", ")` straight to
the admin — so today a CNAME'd DKIM selector shows the hostname and the TXT value run together under
"DKIM record". The audit's pass/fail status is still correct (`found.length > 0`), so this is a
display bug, not a wrong verdict.

**Applies to Kite?** Yes — a real, currently-visible (if minor) display bug for DKIM, plus the same
latent gap for any future A/AAAA caller that upstream's SSRF-adjacent use case illustrates.

**Recommendation: adapt.** Small, isolated type filter in `queryDns`; fixes the DKIM display
immediately and removes the latent risk for a future IP-validation caller.

## C. Performance / reliability

### 7. API keys verified with `bcrypt` on every request

**Upstream:** `d8ff1a7` — "Verify API keys with SHA-256 to fit the Workers free-tier CPU limit" (#245).

**What it does:** `bcrypt` on every API-authenticated request was exceeding the Workers free-tier
10ms CPU budget. New keys and app passwords store a SHA-256 hash and are compared in constant time;
old keys fall back to `bcrypt` until reissued. Account passwords stay on `bcrypt` (low-frequency,
needs the slow hash).

**Does Kite have it or an equivalent?** No. `src/lib/api-keys.ts` calls `bcrypt.hashSync(fullKey, 10)`
/ `bcrypt.compareSync` unconditionally, and `verifyApiKey` is called from `src/lib/api/key-auth.ts`
(every `/api/v1` request) and `src/lib/mcp/auth.ts` (every MCP request) — potentially once per
candidate key in a loop. This is the exact hot path upstream flagged, on the same Workers runtime
and the same free-tier CPU limit.

**Applies to Kite?** Yes, directly. Kite's API keys are high-entropy random secrets (not
user-chosen passwords), so a fast constant-time hash is not a meaningful weakening versus `bcrypt`
for this use — the entropy, not the hash cost, is what resists guessing. Account/mailbox passwords
should stay on `bcrypt` as upstream also kept them.

**Recommendation: adapt.** Port the approach, not the files: Kite has no MySQL/Postgres dialects (see
`ROADMAP.md` milestone 7, "Not planned: Postgres and MySQL"), so skip the multi-dialect migration
files upstream added and write one D1 migration plus the legacy-key fallback path. Worth doing before
it causes a real 500 under load on someone's free-tier Worker.

### 8. Landing page shows a logged-out flash for signed-in visitors

**Upstream:** `d4dc833` — "show the signed-in landing account immediately" (#262).

**What it does:** The landing page resolved auth only after hydration (a client `/api/auth/me`
fetch), so a signed-in visitor saw the logged-out header for ~440–765ms. Resolve the cookie session
server-side in the page and pass it down; keep the trigger usable (as a link to the inbox) before
hydration finishes.

**Does Kite have it or an equivalent?** No — same gap. `src/app/page.tsx`'s `HomePage` is an async
server component but only resolves branding server-side; `src/app/home-auth.tsx`'s
`HomeAuthProvider` is `"use client"` and resolves the user purely via the `useAuthMe()` client hook,
so a signed-in visitor gets the same flash Kite's landing page has been independently redesigned
around (`b5c433b`) but not fixed for.

**Applies to Kite?** Yes, same file names even (`home-auth.tsx`), same client-only pattern.

**Recommendation: adapt.** Resolve the session cookie server-side in `HomePage` (`src/app/page.tsx`)
next to `getHomeBranding()`, pass it into `HomeAuthProvider` as initial state, and keep
`useAuthMe()` as the client-side refresh/fallback. Pure perceived-performance polish, low risk,
needs re-checking against Kite's own (already quite different) landing page structure rather than
copying upstream's `home-auth.tsx` diff.

### 9. Folder switching and message opening made instant (large perf refactor)

**Upstream:** `4788c2d` — "make folder switching and message opening instant" (#256). ~30 files,
measured 879–1498ms → 47–83ms for a warm folder switch; removes a fixed-timer progress bar in favor
of hover/focus prefetch, patches caches in place instead of invalidating them, and windows
prev/next navigation instead of shipping every id in a folder.

**Does Kite have it or an equivalent?** Partially. Kite already has `src/lib/messages/detail-cache.ts`
(a shared ancestor concept) but no `message-thread-cache.ts`-equivalent, no hover/focus-triggered
full-route prefetch, and `usePageLoading` still takes a plain boolean (no "skip the artificial
delay" flag). The specific perf problem upstream measured (slow folder switch, slow message open) is
plausible in Kite too, but unverified — this wasn't load-tested here.

**Applies to Kite?** Conceptually, but this is a deep, invasive refactor (list caching, detail
caching, navigation windowing, Intl-object memoization) against Mailflare's current component
internals, which have diverged substantially from Kite's own (Screener, conversation view, all-mailboxes,
unified reading pane work that doesn't exist upstream). Not a safe direct port.

**Recommendation: adapt selectively, as its own scoped perf pass**, not a port of this diff. The
individual ideas are worth stealing deliberately: prefetch the list on hover/focus with the exact key
the list will request; stop clearing+refetching caches on read/unread and patch in place; window
prev/next navigation instead of sending every id; memoize `Intl` formatter instances in list rows
(`src/lib/time/utils.ts` is a reasonable place to check first). Size as its own investigation once
someone profiles Kite's current folder-switch and message-open timings — don't assume the numbers
transfer.

## D. Feature gaps

### 10. One-click and `mailto:` unsubscribe, plus bulk unsubscribe-and-trash

**Upstream:** `0fe13b1` — "one-click + mailto unsubscribe, and unsubscribe-&-delete-all" (#243).

**What it does:** A big feature add. One-click `List-Unsubscribe-Post` (RFC 8058) with its own SSRF
guard (public https only, resolves to public IPs only, never follows redirects, gated on a DKIM
signature covering `List-Unsubscribe`); `mailto:` unsubscribe sent server-side through the account's
own sending provider (never lands in Sent or contacts, sanitized against header injection, capped,
single recipient); a per-user rate limit; a `has_unsubscribe` column so the message list can show the
action without opening the message; and "Unsubscribe & delete all", which previews then moves the
sender's past mail to Trash in one bounded `UPDATE`, audit-logged, manage-access required.

**Does Kite have it or an equivalent?** Partially. Kite already extracts the `List-Unsubscribe`
value at intake (`src/lib/email/unsubscribe.ts`) and offers an "Unsubscribe" menu action
(`src/components/message-actions/message-actions.tsx`) that opens an `http(s)` URL in the browser or
hands a `mailto:` link to the OS mail client, falling back to a confirm-then-trash-and-block when
there's no link at all. That already sidesteps *server-side* SSRF for the common case (the fetch, if
any, happens in the visitor's browser, not Kite's Worker), but it has none of: automatic RFC 8058
one-click (the user still has to follow a link), server-sent `mailto:` unsubscribe (so it still opens
the user's own mail client instead of going out through the mailbox), per-sender bulk trash, a list
column, or the `has_unsubscribe` flag.

**Applies to Kite?** Partly — the underlying header extraction is shared, but the UI, inbound schema
and send path have diverged enough that this isn't a drop-in port.

**Recommendation: adapt, as a scoped feature follow-up, not a quick port.** The one-click and
bulk-unsubscribe pieces are genuinely valuable (less friction, fewer stray clicks landing on a
tracking/phishing link) but need their own design pass against Kite's current
`message-actions.tsx`, `inbound.ts` and `send.ts` — including deciding whether server-side one-click
fetch is wanted at all given Kite's current client-side-safe default. Worth a dedicated spec, not a
drop-in of upstream's diff.

### 11. Opening a message currently ends a checkbox selection instead of keeping it

**Upstream:** `2413781` — "Fix message selection and keep the focused message visible" (#229).

**What it does:** Two fixes bundled together. (1) A message is now marked read through a plain
async call (`markMessageRead`) instead of a mount-triggered `useEffect` component, and an already-open
message's read state is re-synced from the cache when a bulk action elsewhere changes it, instead of
needing a remount. (2) Opening a message used to replace/cover the reader with the bulk-selection
pane; it's renamed `BulkMessageActionBar` and now sits *above* the focused message instead of
replacing it, so selecting messages no longer hides whatever is open.

**Does Kite have it or an equivalent?** No. Kite's own code says so: `message-split-layout.tsx`
comments that "opening a message ends a checkbox selection; otherwise the selection pane would keep
covering" the reader — i.e. Kite still has exactly the behavior upstream decided was a bug, by
design, for the same reason (the old selection pane would otherwise cover the open message). Kite's
`mark-read.tsx` is also still the pre-fix `useEffect`-on-mount `MarkAsRead` component, not the
plain-call-plus-cache-resync pattern.

**Applies to Kite?** Partially — the underlying problem (selection and an open message fight over the
same space) is real in Kite too, but Kite's `message-split-layout.tsx` is a materially different,
more capable layout (single/stacked/split-column modes, `MessageReadingHeaderButton`, panel
visibility) than upstream's. Copying the component rename and prop plumbing verbatim isn't safe; the
underlying idea (keep the selection, show bulk actions as a bar instead of a covering pane) is sound.

**Recommendation: adapt.** Worth revisiting whether Kite should still drop the selection on open,
given upstream's reasoning, but needs its own pass against the current split-layout component rather
than the upstream diff. Lower priority than the correctness/security items above — it's a workflow
annoyance (losing a selection when you peek at a message), not a bug that loses data or exposes
anything.

### 12. Web passkey authentication and secure sign-in policies (major feature)

**Upstream:** `b90d61a` — "Add web passkey authentication and secure sign-in policies" (#231).
153 files, ~34k lines: WebAuthn registration/sign-in/step-up flows, a "first passkey" sign-in-method
chooser, recovery-code and authenticator-app interplay, new DB tables, and new MySQL/Postgres
migration dialects Kite doesn't have.

**Does Kite have it or an equivalent?** No. Kite has TOTP-based MFA (`src/lib/auth/mfa.ts`,
`src/components/settings/mfa-settings.tsx`) but no WebAuthn/passkey support at all.

**Applies to Kite?** Conceptually yes (it's a real security upgrade users would want), but this is
upstream's single largest change in the window, built against Mailflare's current auth stack
(`src/lib/auth/*`, `src/components/settings/*`), which has diverged from Kite's own (different
session/cookie handling, different settings UI, no MySQL/Postgres surface to drop). Milestone 4
("Security hardening") in `ROADMAP.md` doesn't currently list passkeys.

**Recommendation: adapt, but size it as its own milestone/mission, not a port.** This is valuable
enough to propose as a roadmap item in its own right — WebAuthn registration, step-up auth, "first
passkey" UX decisions, and the interaction with Kite's existing TOTP MFA all need designing against
Kite's own auth code, not transplanting upstream's. Flagging it here so it's not lost, not
recommending it be attempted inside a routine port.

## E. UI polish

### 13. Dark-theme modal backdrops wash out instead of dimming

**Upstream:** `e3afaf1` — "stop modal backdrops from lightening the dark theme" (#261).

**What it does:** The dark theme remaps `neutral-900`/`neutral-950` to near-white, so a
neutral-based scrim lightens the page instead of dimming it. Use `black` for every backdrop, with a
stronger dark-mode alpha.

**Does Kite have it or an equivalent?** Mixed. Kite's own `src/components/ui/dialog.tsx` already
uses `bg-black/35` — not affected. But two hand-rolled backdrops use the same pattern upstream just
fixed: `src/app/(calendar)/calendar/page.tsx:846` (`bg-neutral-950/35`) and
`src/components/compose/compose-form.tsx:726` (`bg-neutral-950/65`). Kite's dark theme does the same
remap (`globals.css`: `--color-neutral-950: #fafafa` under `.dark[data-style="kite"]`), so both of
these wash out instead of dimming in dark mode — confirmed by reading the CSS, not just by analogy.

**Applies to Kite?** Yes, directly, in exactly two files.

**Recommendation: port.** Small, isolated, visually confirmable fix: change those two backdrops to
`bg-black/*` to match `dialog.tsx`'s existing (already-correct) convention.

### 14. Mobile message-action toolbar can overflow and push its own "More" trigger off-screen

**Upstream:** `e19104f` — "fit mobile message actions inline and keep the menu on screen" (#260).
Replaces a hand-rolled, breakpoint-hardcoded action row and an overflow panel that could open
off-screen or run below short viewports, with a priority-ordered row plus a `ResizeObserver` and a
portaled Radix dropdown.

**Does Kite have it or an equivalent?** Partially, and less than first appears. Kite's
`src/components/message-actions/message-actions.tsx` already uses a Radix `Popover` for "More
actions" (`max-h-(--radix-popover-content-available-height)`), which gets Radix's built-in viewport
collision handling once the popover is open — so the specific "menu panel opens off-screen" failure
upstream describes is likely already avoided. That's a different problem, though, from the toolbar
*row* itself overflowing: the row is a plain `flex min-w-0 items-center gap-1` with no
`flex-wrap`, no horizontal scroll and no `ResizeObserver`-based reordering. At a narrow width (a
small phone, or Kite's own split/stacked reading-pane layout at a pinched size) with every action
plus something like a Summarize button in the same header, the row can overflow its container and
push the "More actions" trigger itself out of view — which Radix's collision handling, acting only on
already-open popover *content*, cannot fix, because the trigger was never reachable to open it.

**Applies to Kite?** Plausibly yes — not confirmed with an actual narrow-viewport run (this report
doesn't drive the UI), but the layout code supports the concern: nothing in `message-actions.tsx`
compresses, scrolls or reorders the row under width pressure.

**Recommendation: adapt — treat as an existing, unverified-but-plausible layout bug**, not a
"check back if it comes up" item. A `ResizeObserver` that moves whatever doesn't fit into the
overflow menu (as upstream does) is the direct fix; at minimum, give the toolbar row `overflow-x-auto`
or `flex-wrap` as a cheap mitigation pending a proper pass, and verify at a genuinely narrow viewport
(≈280px) with every optional header button present.

## Already covered or not applicable

- **`c931884` — "allow rescheduling a scheduled send" (#233) (#235).** Kite already solves the
  underlying problem differently and, on the race-condition front, more robustly: a queued/scheduled
  send shows a `SendStateBanner` with **Edit** (reopens as a draft via `/api/send/undo`, which
  "un-claims" the outbound job) and **Cancel send**, backed by `src/lib/email/job-claim.ts`'s claim
  mechanism, rather than upstream's inline reschedule-the-same-row datetime field. Different UX for
  the same end goal (change when a scheduled message goes out); no action needed.
- **`2273778` — "per-user Calendar and Drive visibility" (#205) (#242).** Superseded by Kite's own,
  more general module platform (`ROADMAP.md` milestone 19, shipped in `#45`): any module — not just
  Calendar and Drive — can be restricted per user under Accounts → Permissions
  (`src/app/(admin)/accounts/[id]/permissions/module-access-section.tsx`, `user_module_access`
  table). Skip.
- **`7a48167` — "Fix Windows test fixtures" (#252).** Fixes esbuild path-separator handling and
  32-catalog i18n parity in Mailflare's own test harness. Kite's interface-translation catalog
  (`ROADMAP.md` milestone 1, item 5) hasn't shipped yet, and the test-fixture specifics are
  Mailflare-internal. Not applicable.
- **`df77f52` — "minor update" (mailboxes list columns/status badges).** Pure UI polish to
  Mailflare's admin mailboxes list (type/status/last-sign-in columns). Low value against Kite's own,
  already-diverged admin UI (recent Radix select/checkbox pass, `#428`). Skip unless someone wants
  the specific "last sign-in" column as a small follow-up.
- **`0162369` ("pump version")**, **`be89083` ("Added changelog")**,
  **`b7d1f74` ("Create pull_request_template.md")**, **`aee7ee1` (merge commit).** A version bump,
  upstream's own changelog archive, a GitHub PR template and a merge commit with no independent
  diff. Not applicable to Kite.

## Summary table

| # | Upstream | PR | Kind | Recommendation |
|---|----------|----|------|-----------------|
| 1 | `cd4210b` | #228 | Feature, security-relevant | Adapt |
| 2 | `e7d2146` | #250 | Correctness, security-adjacent | Adapt |
| 3 | `64274a6` | #241 | Correctness | Adapt |
| 4 | `638a5e6` | #255 | Correctness | Adapt |
| 5 | `d231a05` | #251 | Correctness | Adapt |
| 6 | `8af747f` | #249 | Correctness (minor, confirmed) | Adapt |
| 7 | `d8ff1a7` | #245 | Performance / reliability | Adapt |
| 8 | `d4dc833` | #262 | Perf polish | Adapt |
| 9 | `4788c2d` | #256 | Perf (large refactor) | Adapt (scoped follow-up) |
| 10 | `0fe13b1` | #243 | Feature (partial gap) | Adapt (scoped follow-up) |
| 11 | `2413781` | #229 | Feature / UX | Adapt |
| 12 | `b90d61a` | #231 | Feature (major) | Adapt (own milestone) |
| 13 | `e3afaf1` | #261 | UI bug | Port |
| 14 | `e19104f` | #260 | UI bug (plausible, unverified) | Adapt |
| — | `c931884` | #233/#235 | Feature | Skip — equivalent exists |
| — | `2273778` | #205/#242 | Feature | Skip — superseded by module platform |
| — | `7a48167` | #252 | Test infra | Not applicable |
| — | `df77f52` | — | UI polish | Skip |
| — | `0162369`, `be89083`, `b7d1f74`, `aee7ee1` | — | Repo meta | Not applicable |

No code is ported by this document. Findings 1–6 are the most actionable next (no migration beyond
#7, small and isolated); #9 and #12 are the ones worth proposing as their own scoped pieces of work
rather than attempting inside a routine port.
