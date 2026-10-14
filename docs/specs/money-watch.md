# Spec: Money Watch (subscription tracking as a builtin module)

Status: Draft for review, for a Factory Mission on `mission/money-watch`. Written against `main` at `b8afdb8`. The next free migration number is 0063 (journal `idx` 66); [drive storage](drive-storage.md) also plans 0063 and 0064, so take the next free number when you start if another branch lands first (§23, question 3). Scope: Roadmap milestone 18 ([complete suite](../roadmap-complete-suite.md#milestone-18-subscriptions-money-watch)). Money Watch is the first new module on the shipped [module platform](module-platform.md) and follows "Adding a builtin module" in [Modules](../modules.md); it adds no registry, helpers or infrastructure of its own. Everything marked **(new)** is an API, field or file this spec proposes; everything else exists at `b8afdb8`.

## 1. Summary

Most people pay for more subscriptions than they remember, and the evidence is already in their mailbox: receipts, invoices, "your trial ends" and "payment failed" mail. Money Watch reads that mail during automatic reading, offers to track what it finds, and reminds the user before something renews.

- **Detection** is a `triage_step` capability. It is deterministic (subject, sender and body patterns, amounts, cycles and dates, attachments, a recurring sender and amount) and produces at most one `subscription` suggestion per message: "Netflix $17.99/month, renews 1 Nov. Track it?".
- **Tracking** writes a row in the module's own table only when the user accepts, through `agent_actions` (`create_subscription`) with undo. Later invoices from the same vendor offer to update the row and flag price changes. Users can also add a subscription by hand or from any message.
- **Nudges** come from a module cron task: a realtime notice, a count on the Subscriptions nav item and, when Calendar is on for the user, a calendar reminder created through a new Calendar `service`. "Cancel before 1 Nov" opens the sender's `List-Unsubscribe` link in the browser on a click, never from the server.
- **The Subscriptions view** at `/money` lists upcoming renewals first, with monthly and yearly totals, vendor history linked to its mail, editing, status changes and per-item reminders.

Design principles:

1. **Off means absent.** With the module off for the install or for a user there is no nav item, card, cron work, tool, search section or event; pages and API answer 404; data is kept.
2. **Deterministic first, and v1 is deterministic only.** No model call is added. Billing mail is almost always automated, bulk or no-reply, so the triage model does not run on it anyway (`needsModel`, `src/lib/agent/auto-read/facts-utils.ts:174`).
3. **Suggest only.** Only autonomy `off` and `suggest` can be saved today (`autonomyError`, `src/lib/agent/auto-read/settings-utils.ts:64`). No subscription is tracked or changed, and no calendar event is created, without a user decision; tracking a row (with its per-item calendar reminder, on by default) is that decision, and the cron only updates reminder bookkeeping on tracked rows (§10.1).
4. **Every user decision is audited and reversible** in `agent_actions`, including manual edits.
5. **The cancel link comes only from the `List-Unsubscribe` header**, never from the body, an attachment or a model, and it only opens on a click.
6. **No Money Watch code in core.** Every core change in §16 is generic ("a module-owned suggestion kind", "a module sidebar item"), so the next module (alerts, bills) reuses it. `tests/module-imports.test.mjs` keeps enforcing the boundary.

Non-goals for this milestone: bank or card connections, currency conversion, automatic tracking without a click (waits for an Act level), server-side unsubscribe or cancellation requests, OCR of image receipts, model extraction (designed in §5.7, deferred), the assistant suggesting "enable Money Watch" while it is off (milestone 19, item 5), REST `/api/v1` endpoints and write tools for the assistant.

## 2. Module identity

| Field | Value | Why |
| --- | --- | --- |
| Module id | `money` | Single word like the existing ids. It reads well in every derived name (below) and leaves room for bills and receipts later. `subscriptions` would give `subscriptions:subscription` and clashes with webhook and SNS "subscriptions"; `moneywatch` is long and unlike the other ids. |
| Display name | "Money Watch" | From client data `name`; the nav item is labelled "Subscriptions". |
| `runtime` | `"builtin"` | |
| `dependsOn` | `[]` | Calendar is optional: reminders degrade when it is off (§11). A dependency would force Calendar on for every Money Watch user. |
| `defaultEnabled` | `true` | Detection only runs where the mailbox owner already turned automatic reading to `suggest`, and nothing is stored without a click, so turning it on for existing installs surprises nobody. It also keeps the registry assertion `defaultEnabled === true` (`tests/module-registry.test.mjs:68`). See §23, question 2. |
| Pages | `/money` | Route group `src/app/(money)/`. |
| API prefix | `/api/money` | Session auth only, no public routes. |
| Record kind | `money:subscription` | |
| Grants | `money.read`, `money.write` | |
| MCP scope | `mcp:money-read` (`mailboxBound: false`) | Data is per user, not per mailbox. |
| REST key scopes | none in v1 | No `/api/v1` surface yet. |
| Webhook events | `money.subscription.detected`, `money.subscription.renewal_due` | Module-prefixed like `calendar.event.created`; the roadmap's unprefixed names are §23, question 8. |
| Suggestion kind | `subscription` | New. The reserved `receipt` kind stays for "file under Receipts" ([auto-agent spec](auto-agent.md) line 80). |
| Tables | `money_subscriptions`, `money_charges` | Namespaced by module id; the roadmap says `subscriptions` (§23, question 4). |
| Implementation | `src/lib/money/` | Module directory `src/lib/modules/money/` holds only the four platform files. |

## 3. Manifest

`src/lib/modules/money/manifest.ts` **(new)**, listed in `MODULE_MANIFESTS` (`src/lib/modules/registry.ts`) after `import`. Client-safe data only.

```ts
import { moneyClientData } from "../client-data/money";
import type { ModuleManifest } from "../module-types";

export const moneyManifest: ModuleManifest = {
	id: "money",
	name: moneyClientData.name, // "Money Watch"
	description: "Finds subscriptions in receipts and invoices, tracks renewals and reminds you before they renew.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/money" }],
	apiPrefixes: [{ prefix: "/api/money" }],
	nav: moneyClientData.nav,
	commands: moneyClientData.commands,
	composerSlots: [],
	messageSlots: moneyClientData.messageSlots, // (new) §16, C13
	recordKinds: [{ kind: "money:subscription", label: "Subscription", unavailableLabel: "Subscription" }],
	webhookEvents: [
		{ value: "money.subscription.detected", label: "Subscription detected", hint: "A subscription was added to Money Watch" },
		{ value: "money.subscription.renewal_due", label: "Subscription renewal due", hint: "A tracked subscription renews or its trial ends soon" },
	],
	grants: [
		{ grant: "money.read", label: "Read subscriptions" },
		{ grant: "money.write", label: "Add, change and remove subscriptions" },
	],
	mcpScopes: [{ scope: "mcp:money-read", label: "Read subscriptions", grants: ["money.read"], mailboxBound: false }],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [{ id: "subscriptions", label: "Subscriptions" }],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [{ name: "remindRenewals", schedule: "*/5 * * * *", capability: "remindRenewals" }],
	actionLabels: {
		create_subscription: "Started tracking a subscription",
		"create_subscription:update": "Updated a tracked subscription from a new invoice",
		update_subscription: "Changed a subscription",
		"update_subscription:reminder": "Changed a subscription reminder",
		"update_subscription:payment_failed": "Marked a subscription payment as failed",
		set_subscription_status: "Changed a subscription's status",
		"set_subscription_status:cancelled": "Marked a subscription as cancelled",
		"set_subscription_status:active": "Marked a subscription as active",
		"set_subscription_status:expired": "Marked a subscription as expired",
		"set_subscription_status:trial": "Marked a subscription as a trial",
		delete_subscription: "Removed a subscription",
	},
	reasonTexts: {
		subscription: "The message looks like a subscription receipt, invoice or renewal notice",
		subscription_price_change: "The amount differs from the tracked subscription",
		subscription_payment_failed: "The message says a subscription payment failed",
		subscription_trial: "The message mentions a free trial ending",
		"module_disabled:money": "Money Watch is turned off",
		migration_pending: "The database update for Money Watch has not been applied yet",
	},
};
```

Client data, `src/lib/modules/client-data/money.ts` **(new)**, added to `CLIENT_MODULES`:

```ts
export const moneyClientData = {
	id: "money",
	name: "Money Watch",
	nav: [
		{
			id: "money.subscriptions",
			label: "Subscriptions",
			href: "/money",
			icon: "WalletCards", // needs a NAV_ICONS entry, src/components/modules/client-registry.ts
			placement: "sidebar", // (new) §16, C12
			count: { endpoint: "/api/money/badge" }, // (new) §16, C12
			keywords: ["money", "subscriptions", "renewals", "bills", "trials"],
			order: 20,
		},
	],
	commands: [
		{ id: "money.open", moduleId: "money", label: "Open Subscriptions", description: "Show tracked subscriptions and renewals", group: "Money Watch", target: { type: "route", href: "/money" }, effect: "navigate" },
		{ id: "money.add", moduleId: "money", label: "Add a subscription", description: "Track a subscription by hand", group: "Money Watch", target: { type: "route", href: "/money?add=1" }, effect: "navigate" },
	],
	messageSlots: [{ id: "money.track-message", slot: "message-menu", order: 50, label: "Track as subscription" }], // (new)
	suggestionKinds: ["subscription"],
	suggestionKindMeta: { subscription: { label: "Subscription", reason: "Looks like a subscription", badgePriority: 40, icon: "WalletCards" } }, // (new) §16, C2
	keyScopes: { mcp: [{ scope: "mcp:money-read", label: "Read subscriptions", description: "List tracked subscriptions and renewals", mailboxBound: false }], api: [] },
} satisfies ClientModuleData;
```

## 4. Capability descriptors

`src/lib/modules/money/capabilities.ts` **(new)**, generated from zod schemas in `src/lib/modules/money/schemas.ts` **(new)** with `describeCapability`, added to `MODULE_CAPABILITIES`. Handlers in `src/lib/modules/money/server.ts` **(new)**, added to `SERVER_MODULES`; each one only calls into `src/lib/money/`.

| Name | Surfaces | Scopes | Effect | Declaration details |
| --- | --- | --- | --- | --- |
| `detect` | `triage_step` | `money.read` | `read` | `triage: { order: 20, automatic: true, capability: "subscriptions" }` (both keys new, §16 C6 and C8), `timeoutMs: 15000` |
| `subscription` | `suggestion_kind` | none | `none` | `suggestionKind: { kind: "subscription", label: "Subscription", reasonTemplate: "subscription", answer: "answerSubscription", audience: "reviewer" }` (`audience` new, §16 C4). Its input schema is the payload schema (§5.8). |
| `answerSubscription` | `service` | `money.read`, `money.write` | `create` | Called by core on an accept click with `{ suggestionId, option, deviceTimeZone }`; options `track` and `mark_urgent`. |
| `trackSubscription` | `action` | `money.write` | `create` | `action: { actionType: "create_subscription", variants: ["", "update"], undoable: true, permission: "manage", reopensSuggestion: true }` (`reopensSuggestion` new, §16 C9) |
| `editSubscription` | `action` | `money.write` | `update` | `action: { actionType: "update_subscription", variants: ["", "reminder", "payment_failed"], undoable: true, permission: "manage", reopensSuggestion: true }` |
| `setSubscriptionStatus` | `action` | `money.write` | `update` | `action: { actionType: "set_subscription_status", variants: ["active", "trial", "cancelled", "expired"], undoable: true, permission: "manage" }` |
| `deleteSubscription` | `action` | `money.write` | `delete` | `action: { actionType: "delete_subscription", variants: [""], undoable: true, permission: "manage" }` |
| `resolveRefs` | `resolve_refs` | `money.read` | `read` | `refs: { kinds: ["money:subscription"] }`, `resolveRefsSchemas` |
| `search` | `search` | `money.read` | `read` | `search: { section: "subscriptions" }` |
| `listSubscriptions` | `assistant_tool`, `mcp_tool` | `money.read` | `read` | Tool name `list_subscriptions` |
| `remindRenewals` | `cron` | `money.read`, `money.write` | `update` | `cron: { task: "remindRenewals" }`, `timeoutMs: 30000` |
| `subscriptionDetected` | `webhook_event` | none | `none` | `event: { value: "money.subscription.detected" }` |
| `renewalDue` | `webhook_event` | none | `none` | `event: { value: "money.subscription.renewal_due" }` |

All action handlers implement the existing `actionSchemas` contract (`src/lib/modules/shared-schemas.ts:71-91`): `op: "execute" | "undo" | "authorize_undo"`, idempotent by `actionId`, returning `{ result, inverse }` or `refused`. `promptFragment`: "Money Watch tracks the user's subscriptions. Use list_subscriptions for questions about renewals, trials and recurring spend; amounts are in the currency shown and are never converted."

Tool and service shapes:

```ts
// list_subscriptions (assistant_tool + mcp_tool)
input:  { status?: "active" | "trial" | "cancelled" | "expired" | "all"; dueWithinDays?: number /* 1..366 */; limit?: number /* 1..50, default 20 */ }
output: { subscriptions: { ref: RecordRef; vendor: string; plan: string | null; amount: { minor: number; currency: string } | null;
                           cycle: Cycle | null; status: Status; nextRenewalOn: string | null; trialEndsOn: string | null; urgent: boolean }[];
          totals: { currency: string; monthlyMinor: number; yearlyMinor: number }[] }

// answerSubscription (service; suggestionKind.answer)
input:  { suggestionId: string; option: "track" | "mark_urgent"; deviceTimeZone: string | null }
output: { result: { status: "accepted"; actionId: string; subscription: RecordRef } | null; refused?: { status: 400 | 403 | 404 | 409; error: string } }
```

## 5. Detection and extraction

### 5.1 Where it runs

```text
delivery → scheduleAgentWork (schedule.ts) → triageMessageGate  ── automatic mail now passes when an enabled step opts in (C6)
        → agent_jobs(triage) → processAgentTriageJob (process.ts)
        → modelStep            ── v1 adds nothing; a refused model no longer stops module steps (C7)
        → runModuleTriageSteps → invokeCapability("money", "detect", stepInput, { trigger: "auto_read", viewer: reviewer, mailboxIds: [mailbox] })
        → validateStepOutput (≤ 3 suggestions, payload checked against the `subscription` descriptor)
        → planSuggestions      ── muted senders already drop module suggestions
        → storeTriageSuggestions ── module kinds stored (C1), titled by the step (C3)
        → settleTriageSuggestions ── existing realtime `agent_suggestion` ping
```

Detection therefore inherits every existing rule: autonomy `off` means no detection, the kill switch, pause and daily limit apply, the reviewer is the viewer, and per-user module state is checked for the reviewer (`isModuleEnabled`). Manual add (§9.4) works whatever the autonomy.

The step skips itself, returning `{ suggestions: [], skipped }`, when:

| Condition | `skipped` | Source |
| --- | --- | --- |
| `facts.phishing` is not empty | none (silent) | A phishing-flagged "invoice" must never become a card. |
| `facts.spam` is true **(new input)** | none | The message is in Spam. |
| No candidate (score below threshold, §5.3) | none | The common case, costs only regex over 8 KB. |
| `money_subscriptions` missing (migration 0063 not applied) | `migration_pending` | Detected with the same missing-table check `src/lib/modules/state.ts` uses. |

### 5.2 Step input

The existing input (`triageStepSchemas`, `src/lib/modules/shared-schemas.ts:38-68`) carries no headers or body. §16 C5 widens it generically; zod strips unknown keys, so Calendar's step is unaffected:

```ts
input: {
	message: { id, mailboxId, from, fromName /* new */, subject, receivedAt, textExcerpt /* new: ≤ 8 KB of bodyText, nullable */ },
	facts: { authPassed, bulk, knownContact, phishing, automatic /* new */, noReply /* new */, list /* new */, spam /* new */ },
	headers: { listUnsubscribe: string | null, listUnsubscribePost: string | null, listId: string | null }, // new
	attachments: [{ id, contentType, filename, size }],
	model: TriageResult | null,
}
```

`textExcerpt` is the `bodyText` that `src/lib/agent/auto-read/triage-context.ts:57` already computes (`textBody` or readable text from `htmlBody`), cut at 8,192 characters. The headers come from the `readRawHeaders` map already loaded there (lower-case keys, first value). Nothing new is read from R2.

### 5.3 Deterministic detector

`detectSubscription(input, now)` in `src/lib/money/detect-utils.ts` **(new)** is pure and fully unit-tested. All patterns are linear-time (no nested quantifiers) and run on at most the subject (≤ 300 characters) and the 8 KB excerpt.

Signals, each with a code that ends up in `payload.signals`:

| Code | Signal | Weight |
| --- | --- | --- |
| `subject_keyword` | Subject matches receipt, invoice, payment received/confirmation, billing, renewal, renews, subscription, membership, plan, trial (English, Dutch, German, French and Spanish lists in `src/lib/money/keywords-utils.ts` **(new)**) | 2 |
| `billing_sender` | Sender local part is billing, invoice(s), receipt(s), payments, accounts, or no-reply with a subject keyword | 1 |
| `amount` | A currency amount in the subject or excerpt (§5.4) | required |
| `cycle` | `/month`, `per month`, `monthly`, `/mo`, `per year`, `annual(ly)`, `yearly`, `/yr`, `weekly`, `quarterly`, `every 3 months` and equivalents | 3 |
| `renewal_date` | "renews on", "next billing date", "next payment", "will renew", "auto-renews", "your next charge" followed by a date (§5.5) | 3 |
| `trial` | "trial ends", "free trial ... until", "trial expires" followed by a date | 3 |
| `recurring` | A tracked subscription with the same vendor key, or one of the last 5 messages from the same sender in this mailbox (within 400 days) carried the same amount and currency (§5.6) | 3 |
| `invoice_attachment` | A PDF or image attachment whose filename contains invoice, receipt, factuur, rechnung, facture or recibo | 1 |
| `model_receipt` | `model.category === "receipt"` (only when the model ran) | 1 |
| `payment_failed` | "payment failed", "declined", "unable to process your payment", "update your payment method", "past due", "payment unsuccessful" | marks the event (§5.8) |

A candidate needs an `amount` **and** at least one of `cycle`, `renewal_date`, `trial` or `recurring`, **and** a total weight of at least 4. One-off receipts (an amount with no recurrence evidence) produce nothing: that is the reserved `receipt` kind's job, not Money Watch's. Payment-failed mail needs no amount when it matches a tracked subscription by vendor key.

Extraction:

- **Vendor.** The sender display name with noise removed ("Billing", "Team", "Payments", "via", "no-reply", quotes), trimmed to 80 characters, control and bidirectional characters removed; else the capitalised first label of the sender's registrable domain.
- **Vendor key.** The sender's registrable domain, lower-case (last two labels, or three when the second-level label is in a short public-suffix list such as `co.uk`, `com.au`, `co.jp`). For payment processors and app stores in `PROCESSOR_DOMAINS` **(new)** (`stripe.com`, `paddle.com`, `paypal.com`, `apple.com`, `google.com`, `fastspring.com`, `chargebee.com`), the key is `<domain>:<slug of the vendor name>`, so two App Store subscriptions stay apart.
- **Plan.** The text after "plan:", "subscription:" or between the vendor name and the amount on the same line, ≤ 80 characters; null when unsure.
- **Cycle.** From the cycle phrase; else from the interval between recurring matches (25-35 days monthly, 85-95 quarterly, 355-375 yearly, 6-8 weekly); else null.
- **Next renewal.** The renewal date; else, when the cycle is known, the message date plus one cycle with `renewalEstimated: true`; else null.

### 5.4 Amounts and currencies

`amount-utils.ts` **(new)**: `parseAmount(text)` finds `<symbol|code> <number>` and `<number> <symbol|code>`. Decimal separators: the last `.` or `,` followed by exactly the currency's minor digits is the decimal mark, the other is a group separator (`1.299,00 €`, `$1,299.00`, `¥1,500`). Amounts are stored as integer minor units.

- Codes: ISO 4217 codes in `CURRENCY_CODES` **(new)**; minor digits 2 by default, 0 for `JPY KRW ISK CLP VND XOF XAF` and the other zero-decimal codes (fixed table), 3 for `BHD KWD OMR JOD TND`.
- Symbols: `€` EUR, `£` GBP, `¥` JPY, `₹` INR, `CHF`, `kr` only with a code nearby. `$` is USD unless `CA$`, `A$`, `NZ$`, `HK$`, `S$`, `MX$`, `R$` or a code appears in the same line. The user can always correct the currency (§23, question 20).
- Bounds: `0 < amount ≤ 100,000,000` minor units (1,000,000.00), else rejected. When several amounts appear, prefer the one on the same line as a cycle or "total" phrase, then the largest under 10,000.00.

### 5.5 Dates

Formats: ISO `2026-11-01`, `1 Nov 2026`, `Nov 1, 2026`, `November 1st`, `01/11/2026` and `11/01/2026`. Numeric dates with both parts ≤ 12 are read day-first unless the currency is USD or the sender's domain ends in `.us`, and are dropped when still ambiguous and more than 31 days from the message date. A date with no year takes the next occurrence after the message date. Every date is validated in code: it must lie between 31 days before the message date and **2 years** after it; anything else is dropped. Dates are calendar dates (`YYYY-MM-DD`), stored as 00:00 UTC of that date (§7).

### 5.6 Matching and the recurring signal

1. **Tracked subscription.** The step reads `money_subscriptions` for the reviewer (`user_id = ctx.viewer.userId`) with the same `vendor_key`, preferring the same currency, then the same plan, then the closest amount. A match turns the suggestion into an update (`event: "renewal" | "price_change" | "payment_failed" | "trial"`, `subscriptionId` set). An amount in the same currency that differs from the row is a `price_change` with `previousAmountMinor`.
2. **Untracked history.** Only when the message has an amount but no cycle, renewal or trial phrase, the step asks the host for at most 5 earlier messages from the same sender in the same mailbox within 400 days (`moduleHost.mail.recentFromSender`, **new**, §16 C10) with their excerpts, and runs `parseAmount` on each. The same amount and currency at a plausible interval gives `recurring` and infers the cycle.

Nothing about untracked vendors is stored by the module: the only persistent trace of a detection is the suggestion itself, which core expires after 14 days.

### 5.7 The model (v1: deterministic only)

v1 adds no model call, no prompt text and no schema field. When the model did run (personal, non-bulk mail), `model.category === "receipt"` is a weak corroborating signal and nothing else from the model is read. The roadmap's validated `subscription` object in the triage result is deferred (§23, question 5) because:

- `needsModel` is false for automatic, bulk and no-reply mail (`facts-utils.ts:174-178`), which is nearly all billing mail, so the extraction would almost never run;
- forcing the model for receipts widens spend and external-provider exposure for every mailbox;
- the output budget is 400 tokens (`TRIAGE_MAX_OUTPUT_TOKENS`, `src/lib/agent/auto-read/model-call-utils.ts:9`) and the result schema is closed (`triageResultSchema`, `triage-utils.ts:30`).

Design for later, so the contract stays JSON-only: a `triage_step` descriptor may declare `triage.model: { key, jsonSchema, promptFragment, maxTokens, wantsModel }`. Core merges `jsonSchema` under `properties.modules.<moduleId>.<key>` of `TRIAGE_JSON_SCHEMA`, appends the fragment inside the system prompt (never inside the untrusted block), raises the token cap by `maxTokens` (bounded, for example 150), keeps only that key past the closed schema, and passes it to the step as `model.modules.money.subscription`. `wantsModel: "receipt_signals"` would let `needsModel` return true for automatic mail when the deterministic pre-check scores ≥ 2; the external opt-in (`agent_external_auto_read_allowed`) and the spend caps apply unchanged, as for every triage. The step validates the object with the same rules as §5.4-§5.5, and the cancel URL still comes only from the header.

### 5.8 Suggestion payload and text

The `subscription` descriptor's input schema (validated by `validateStepOutput` and again by core at storage, §16 C1):

```ts
{
	event: "new" | "renewal" | "price_change" | "trial" | "payment_failed",
	subscriptionId: string | null,          // set when it matches a tracked row
	vendor: string,                         // 1..80
	vendorKey: string,                      // 1..120, [a-z0-9.:-]
	plan: string | null,                    // ≤ 80
	amountMinor: number | null,             // integer, 1..100_000_000
	currency: string | null,                // ISO 4217, required when amountMinor is set
	previousAmountMinor: number | null,
	cycle: "weekly" | "monthly" | "quarterly" | "yearly" | null,
	nextRenewalOn: string | null,           // YYYY-MM-DD, within the §5.5 bounds
	renewalEstimated: boolean,
	trialEndsOn: string | null,
	cancelLink: { url: string; oneClick: boolean } | null, // §5.9
	unverified: boolean,                    // !facts.authPassed
	signals: string[],                      // ≤ 8 codes from §5.3
}
```

Title, built in code by `suggestionTitle` in `src/lib/money/text-utils.ts` **(new)** and passed as the step's `title` (§16 C3), ≤ 120 characters:

| Event | Title |
| --- | --- |
| `new` | "Netflix $17.99/month, renews 1 Nov. Track it?" (omits unknown parts: "Netflix $17.99/month. Track it?") |
| `trial` | "Netflix trial ends 1 Nov. Track it?" |
| `renewal` | "Netflix renewed, next on 1 Dec. Update it?" |
| `price_change` | "Netflix now $19.99/month, up from $17.99. Update it?" |
| `payment_failed` | "Netflix payment failed. Mark it urgent?" |

Amounts are formatted with `Intl.NumberFormat` in the reviewer's locale. `reason` is the matching `reasonTexts` code (`subscription`, `subscription_price_change`, `subscription_payment_failed`, `subscription_trial`). The card shows an "Unverified sender" warning when `unverified` is true, like Calendar invites.

### 5.9 The cancel link

`parseCancelLink(listUnsubscribe, listUnsubscribePost)` in `src/lib/money/cancel-link-utils.ts` **(new)**:

- Parse the comma-separated `<...>` entries of `List-Unsubscribe` (RFC 2369), at most 2,048 characters each.
- Keep the first `https:` URL with a hostname that is not an IP literal, `localhost` or a `.local`/`.internal` name, and has no credentials. `http:` is dropped. `mailto:` is dropped in v1 (§23, question 10).
- `oneClick` is true only when `List-Unsubscribe-Post` is exactly `List-Unsubscribe=One-Click` (RFC 8058). It is informational: v1 never sends the POST (§23, question 11).
- The body, attachments and model output are never searched for links. A message without the header has `cancelLink: null` and the view says "No cancel link in this sender's mail".

## 6. Attachments

| Attachment | v1 behaviour |
| --- | --- |
| PDF invoice or receipt | Best-effort text extraction (below), only when the body yielded no amount and the filename or subject matched a keyword. |
| Image receipt (`image/*`) | Signal only (`invoice_attachment`); no OCR. |
| Anything else | Ignored. |

PDF extraction, `src/lib/money/pdf-text-utils.ts` **(new)**, pure apart from `DecompressionStream`, which both runtimes have:

1. Attachments are read only through `moduleHost.mail.readAttachment(ctx, messageId, attachmentId, { maxBytes: 2_097_152 })` (`src/lib/email/module-read.ts:47`). It already checks access through `getAttachmentForUser` and returns `base64` for PDFs; the module never touches R2.
2. Skip encrypted files (`/Encrypt`) and files that were `truncated`.
3. Walk at most 32 `stream ... endstream` objects; inflate `/FlateDecode` streams with `DecompressionStream("deflate")`, capping output at 1 MiB per stream and 4 MiB in total (decompression bombs stop at the cap).
4. Collect text from `Tj`, `TJ`, `'` and `"` operators (literal and hex strings, standard escapes), up to 64 KB, then run the same detector on it. CID fonts and object streams yield little or nothing, which is acceptable.
5. The whole attachment path is bounded by the step's 15-second `timeoutMs`; a timeout is retryable and retries the job, so the extractor also stops itself after 5 seconds and returns what it has.

Extracted text is never stored and never logged. §23, question 6 asks whether this ships in v1 or waits.

## 7. Data model and migration 0063

Schema in `src/db/schema/money.ts` **(new)**, merged into the Drizzle `schema` in `src/db/index.ts` and added to the schema list in `drizzle.config.ts`. Not in `src/db/schema/index.ts`, which is at its `max-lines` baseline.

### 7.1 `money_subscriptions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Derived from the creating action's `actionId`, so a resumed pending action reuses it instead of inserting twice. |
| `user_id` | text NOT NULL → `users.id` ON DELETE cascade | The owner (§13). |
| `mailbox_id` | text → `mailboxes.id` ON DELETE set null | The mailbox the subscription was found in or chosen for audit (§9.5). |
| `contact_id` | text → `contacts.id` ON DELETE set null | The sender's contact, when one exists (§13.3). |
| `vendor` | text NOT NULL | ≤ 80. |
| `vendor_key` | text NOT NULL | §5.3; `manual:<slug>` for by-hand rows without a sender. |
| `plan` | text | ≤ 80. |
| `amount_minor` | integer | Null when unknown. |
| `currency` | text | ISO 4217; non-null when `amount_minor` is set (checked in code). |
| `cycle` | text enum `weekly, monthly, quarterly, yearly` | Null when unknown. |
| `next_renewal_at` | integer (timestamp) | 00:00 UTC of the renewal date. |
| `renewal_estimated` | integer bool NOT NULL default false | |
| `trial_ends_at` | integer (timestamp) | 00:00 UTC of the date. |
| `status` | text enum `active, trial, cancelled, expired` NOT NULL default `active` | |
| `payment_failed_at` | integer (timestamp) | Non-null means urgent; cleared by the next paid invoice or by the user. |
| `reminder_days` | integer NOT NULL default 3 | 0 turns reminders off; 0-30. |
| `calendar_reminder` | integer bool NOT NULL default true | Per item; only acts when Calendar is on for the owner. |
| `last_reminded_for` | integer (timestamp) | The due date the last reminder covered; the cron's idempotency key. |
| `calendar_event_id` | text → `calendar_events.id` ON DELETE set null | The reminder event, if any. |
| `cancel_url` | text | From `List-Unsubscribe` only (§5.9). |
| `cancel_one_click` | integer bool NOT NULL default false | |
| `previous_amount_minor` | integer | Set on a price change. |
| `price_changed_at` | integer (timestamp) | The view flags a change for 90 days. |
| `source_message_id` | text → `messages.id` ON DELETE set null | The message it was first found in. |
| `last_message_id` | text → `messages.id` ON DELETE set null | The latest invoice applied. |
| `created_at`, `updated_at` | integer (timestamp) NOT NULL | |

Indexes: `money_subscriptions_user_vendor_idx (user_id, vendor_key)` (non-unique: two plans from one vendor are allowed), `money_subscriptions_due_idx (status, next_renewal_at)` and `money_subscriptions_trial_idx (status, trial_ends_at)` for the cron, `money_subscriptions_mailbox_idx (mailbox_id)`.

Status transitions are free (the user may set any status); detection only proposes `trial → active` (a paid invoice after a trial) and `payment_failed_at`. Nothing moves a row to `expired` automatically in v1.

### 7.2 `money_charges`

One row per invoice applied to a subscription; it gives the vendor history and its mail links.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `subscription_id` | text NOT NULL → `money_subscriptions.id` ON DELETE cascade | |
| `user_id` | text NOT NULL → `users.id` ON DELETE cascade | Denormalised for owner checks. |
| `message_id` | text → `messages.id` ON DELETE set null | The history keeps the amount after trash retention purges the mail. |
| `outcome` | text enum `paid, failed, trial` NOT NULL | |
| `amount_minor`, `currency` | integer, text | |
| `charged_at` | integer (timestamp) NOT NULL | The message date. |
| `created_at` | integer (timestamp) NOT NULL | |

Indexes: unique `money_charges_subscription_message_idx (subscription_id, message_id)`, `money_charges_user_idx (user_id, charged_at)`.

### 7.3 Migration

`drizzle/migrations/0063_add_money_watch.sql` **(new)**, hand-written in the generated style of 0062 (one statement per line, backticks, `--> statement-breakpoint`), journal entry `{ "idx": 66, "version": "6", "when": 1788851280028, "tag": "0063_add_money_watch", "breakpoints": true }` in `drizzle/migrations/meta/_journal.json`:

```sql
CREATE TABLE `money_subscriptions` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null, `contact_id` text REFERENCES `contacts`(`id`) ON DELETE set null, `vendor` text NOT NULL, `vendor_key` text NOT NULL, `plan` text, `amount_minor` integer, `currency` text, `cycle` text, `next_renewal_at` integer, `renewal_estimated` integer DEFAULT false NOT NULL, `trial_ends_at` integer, `status` text DEFAULT 'active' NOT NULL, `payment_failed_at` integer, `reminder_days` integer DEFAULT 3 NOT NULL, `calendar_reminder` integer DEFAULT true NOT NULL, `last_reminded_for` integer, `calendar_event_id` text REFERENCES `calendar_events`(`id`) ON DELETE set null, `cancel_url` text, `cancel_one_click` integer DEFAULT false NOT NULL, `previous_amount_minor` integer, `price_changed_at` integer, `source_message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `last_message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `money_subscriptions_user_vendor_idx` ON `money_subscriptions` (`user_id`,`vendor_key`);--> statement-breakpoint
CREATE INDEX `money_subscriptions_due_idx` ON `money_subscriptions` (`status`,`next_renewal_at`);--> statement-breakpoint
CREATE INDEX `money_subscriptions_trial_idx` ON `money_subscriptions` (`status`,`trial_ends_at`);--> statement-breakpoint
CREATE INDEX `money_subscriptions_mailbox_idx` ON `money_subscriptions` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `money_charges` (`id` text PRIMARY KEY NOT NULL, `subscription_id` text NOT NULL REFERENCES `money_subscriptions`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `outcome` text NOT NULL, `amount_minor` integer, `currency` text, `charged_at` integer NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `money_charges_subscription_message_idx` ON `money_charges` (`subscription_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `money_charges_user_idx` ON `money_charges` (`user_id`,`charged_at`);
```

- No `module_settings` row is inserted: a missing row already means `defaultEnabled`, and inserting one would break the four-row assertions in `tests/module-migration.test.mjs:94-96` and `tests/backup-module-tables.test.mjs:128-140`.
- `agent_suggestions.kind` and `agent_actions.action` are TypeScript-only enums with no SQL `CHECK` (migration 0060), so the new kind and action types need no SQL.
- The setup path and the Node runtime pick the file up through the migration bundle; nothing else is hand-maintained.
- **Before 0063 is applied** (deploys never migrate): the page renders an empty state that points to the database update banner; `GET` routes answer `{ subscriptions: [], migrationPending: true }`; writes answer 409 `{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" }`; the step returns `skipped: "migration_pending"`; the cron returns without work; refs resolve as unavailable. Every check reads `sqlite_master`, never a new column.

## 8. Backups

Per AGENTS.md, in the same change as the migration:

| List | Change |
| --- | --- |
| `BACKUP_TABLES` (`src/lib/backups/export.ts:8-53`) | Insert `money_subscriptions`, then `money_charges`, directly after `booking_appointments` (after every parent: `users`, `mailboxes`, `contacts`, `messages`, `calendar_events`). |
| `BACKUP_TABLE_GROUPS` (`src/lib/backups/table-groups.ts`) | Both in `mail` ("Mail and related data"), next to `calendar_events` and `email_templates`, which are also per-user data derived from mail. |
| `DatabaseBackupTable` (`src/lib/backups/types.d.ts`) | Add `"money_subscriptions" \| "money_charges"`. |
| `REQUIRED_BACKUP_TABLES`, `INTERNAL_TABLES` | Unchanged: older documents omit the tables and `fillMissingBackupTables` fills `[]`; the tables are user data, not derived. Reminder bookkeeping is columns, not a transient table. |

Behaviour to test (§20): a backup taken before 0063 restores after 0063 with both tables empty; a backup after 0063 round-trips with rows and FK order intact; restoring a document that has Money Watch rows into a database without 0063 fails with the existing "Apply pending database migrations before restoring money subscriptions." message (`src/lib/backups/export.ts:281` replaces underscores with spaces); `assertBackupTablesCoverDatabase` passes on a migrated database.

## 9. Accepting, editing and undo

### 9.1 Writes go through `agent_actions`

Every write a user makes is an `executeAction` row (`src/lib/agent/auto-read/execute.ts:178`): `pending` first, then the module's `execute` handler, then `applied` or `failed`, with `before`/`inverse` stored for undo inside `DEFAULT_UNDO_WINDOW_MS` (7 days, `src/lib/agent/auto-read/actions-utils.ts:15`). Undo uses the existing `POST /api/agent/actions/[id]/undo`; the module's `undo` handler restores the inverse and is idempotent. The module reaches the executor through `moduleHost.actions.execute` **(new, §16 C10)**, so no Money Watch file lives under `src/lib/agent/auto-read/` (unlike Calendar's grandfathered invite files).

| User decision | Action type and variant | Effect | Inverse (undo) |
| --- | --- | --- | --- |
| Track (new) | `create_subscription` `""` | Insert row and a charge; link contact; emit `money.subscription.detected` | Delete row (charges cascade); remove its calendar reminder; reopen the suggestion |
| Track (matches a row) | `create_subscription` `update` | Update renewal date, amount (price change), cycle, cancel link, `last_message_id`; `trial → active` on a paid invoice; clear `payment_failed_at` on a paid invoice; insert a charge | Restore the previous columns, delete the charge; reopen the suggestion |
| Mark urgent (payment failed card) | `update_subscription` `payment_failed` | Set `payment_failed_at`; insert a `failed` charge | Clear it, delete the charge; reopen the suggestion |
| Edit fields | `update_subscription` `""` | Update vendor, plan, amount, currency, cycle, dates | Restore the previous columns |
| Change reminder | `update_subscription` `reminder` | `reminder_days`, `calendar_reminder`; removes the calendar event when turned off | Restore; the cron recreates the event if due |
| Change status | `set_subscription_status` `<status>` | Set status; `cancelled`/`expired` remove the reminder event | Restore the previous status |
| Add by hand or from a message | `create_subscription` `""` with no suggestion | Insert row (and a charge when from a message); emit `money.subscription.detected` with `source: "manual"` (§14) | Delete row |
| Remove | `delete_subscription` `""` | Delete row and charges (snapshot in `inverse`, ≤ 200 charges) | Re-insert both with the same ids |

Dismissing a card is core's existing `dismiss` and touches no Money Watch data. A "Not a subscription" choice that mutes the vendor is deferred.

### 9.2 Accept flow

1. The user clicks **Track** (or **Mark urgent**) on the card; core's `acceptSuggestion` (`src/lib/agent/auto-read/suggestion-api.ts:165`) finds `MODULE_ANSWERERS.subscription`, and `answerSuggestion` (`src/lib/agent/auto-read/module-actions.ts:118`) invokes `answerSubscription` as the user.
2. The service loads the suggestion with `moduleHost.suggestions.get` **(new)**, which returns it only if its kind belongs to `money`, it is still `open`, and the viewer has full access to its mailbox and is its reviewer (audience, §13).
3. It re-validates the payload, re-runs the match against the owner's rows (the row may have been created since detection, so a second accepted card for the same vendor becomes an `update`), and calls `moduleHost.actions.execute` with `capability: "trackSubscription"`, the suggestion and message ids and `before` (the matched row, if any).
4. On success it calls `moduleHost.suggestions.decide(ctx, "money", id, "accepted")` **(new)**, which sets `decided_at`/`decided_by_user_id` and sends the existing quiet realtime ping; the response carries `actionId` for the undo toast.
5. Idempotency comes from the existing live unique index on `(suggestion_id, action, variant)`: a double click returns the same action.

### 9.3 Undo reopens the card

When the undone action's descriptor has `reopensSuggestion: true` **(new)**, core reopens the suggestion after the undo commits if no other live action of the same module remains on it, the same rule as Calendar's `reopenIfIdle` (`src/lib/agent/auto-read/calendar-state.ts:58`) made generic.

### 9.4 Manual add

- **By hand:** the "Add subscription" dialog on `/money` (vendor, plan, amount, currency, cycle, next renewal, trial end, reminder days, calendar reminder, mailbox for the audit row). `POST /api/money/subscriptions`.
- **From any message:** the reader's overflow menu shows "Track as subscription" through the new `message-menu` slot (§16 C13). It calls `POST /api/money/detect { messageId }`, which runs the same detector (§5) through `moduleHost.mail.getMessage` with the new `text` and `headers` options, and opens the dialog prefilled with what it found, including the cancel link from the message's own `List-Unsubscribe`. Nothing is written until the user saves. It works with automatic reading off.

### 9.5 Which mailbox an audit row names

`agent_actions.mailbox_id` is NOT NULL, Activity is per mailbox and the executor checks `manage` on that mailbox. The audit mailbox is the row's `mailbox_id` when the owner still manages it; otherwise the first mailbox the owner manages (oldest first). With none, writes answer 409 `{ code: "NO_MAILBOX", error: "Money Watch needs a mailbox you manage to record changes" }`. Rows added by hand store the mailbox chosen in the dialog (default: the selected mailbox).

## 10. Renewal, payment and cancel nudges

### 10.1 The cron task

`remindRenewals` runs on the `*/5 * * * *` tick through `runModuleCronTasks` on both runtimes (`worker.ts:244`, `server/runtime/scheduler.ts`), with `viewer: null` and grants `money.read`, `money.write`. A daily `0 2 * * *` run would remind people in other time zones at odd hours and, on Node, be missed entirely when the process is down at 02:00.

```text
now = input.scheduledTime ?? Date.now()                       -- C14 passes scheduledTime
due(row) = status = 'trial' AND trial_ends_at ? trial_ends_at : next_renewal_at
SELECT … FROM money_subscriptions
 WHERE status IN ('active','trial') AND reminder_days > 0
   AND due BETWEEN now - 1 day AND now + 31 days
   AND (last_reminded_for IS NULL OR last_reminded_for <> due)
 ORDER BY due LIMIT 100
for each owner (grouped):
  skip unless moduleHost.modules.isEnabledFor(ctx, owner, "money")   -- per-user switch; row untouched
  ctx = per-owner context (viewer = owner, built with buildCallContext as emitAppointmentCreated in src/lib/booking/create.ts does), profile = users.getProfile
  for each row:
    daysLeft = calendar days from today in profile.timeZone to the due date
    if daysLeft > reminder_days: continue                           -- not yet
    claim: UPDATE … SET last_reminded_for = due WHERE id = ? AND (last_reminded_for IS NULL OR last_reminded_for <> due)
    if no row changed: continue                                     -- another tick claimed it
    if daysLeft < 0: continue                                       -- missed while off: claimed, not announced
    notify, emit webhook, upsert calendar reminder                  -- each best-effort, §10.2-§10.4
```

- The claim makes overlapping ticks and the Node scheduler's double tick harmless, and a changed due date (a new invoice) re-arms the reminder automatically.
- A user restricted from Money Watch keeps their rows untouched, so the reminder fires when access returns, if still inside the window.
- `last_reminded_for` and `calendar_event_id` are reminder bookkeeping, not user data, so they are not `agent_actions` rows; the calendar event write is recorded with `moduleHost.audit` (§23, question 16).
- Failures log `money.reminder_failed` with the subscription id and error code only (no vendor, amount or dates), and never stop the loop.

### 10.2 The realtime notice

`moduleHost.notify(ctx, "money", [owner], { notice: "renewal_due", title, body, href })` **(new, §16 C11)** sends a `module_notice` payload over the existing hub. Text: "Netflix renews in 3 days ($17.99)", "Your Netflix trial ends tomorrow", with `href: "/money?subscription=<id>"`. The client shows a toast with an "Open" link and dispatches `kite:module-notice`, which refreshes the nav count. Notices are fire-and-forget (lost when no tab is open); the badge and the view read the database, so nothing depends on delivery.

### 10.3 The badge

`GET /api/money/badge` → `{ count }`: the owner's `active`/`trial` rows whose due date is today or later and within `reminder_days`, plus `active` rows with `payment_failed_at`. The sidebar item's count (§16 C12) fetches it on load, every 5 minutes, on window focus and on `kite:module-notice` or `kite:agent-suggestion` events. Open `subscription` cards also count in For you through the existing For you count.

### 10.4 Cancel before the renewal

Rows with a `cancel_url` show **Cancel before 1 Nov** (the day before the due date). The click opens the link with `window.open(url, "_blank", "noopener,noreferrer")`, the same rule as the reader's unsubscribe button (`openUnsubscribeUrl`, `src/components/message-actions/utils.ts`), after showing the link's host ("Opens netflix.com"). Kite never fetches or POSTs the URL. After the click the row offers "Did you cancel? Mark as cancelled", which is a normal audited `set_subscription_status` write. Without a link, the button reads "Open latest message".

### 10.5 Failed payments

Payment-failed mail for a tracked vendor produces a `subscription` card with `event: "payment_failed"` and reason `subscription_payment_failed` ("Netflix payment failed. Mark it urgent?"); it shares the kind's single `badgePriority` (§3). Accepting sets `payment_failed_at`; the row then sorts into "Needs attention" and counts in the badge. The roadmap says failed-payment keywords "flip the item to urgent"; under suggest-only that flip needs the click (§23, question 15).

## 11. Calendar reminder service

Calendar has no `service` that another module can call to create an event (its `createEvent` is an action executed by the invite helpers, and tools are not reachable through `moduleHost.invoke` with the right grants). This milestone adds two Calendar services. They are Calendar module changes, not core changes.

| Name | Surfaces | Scopes | Effect | Input | Output |
| --- | --- | --- | --- | --- | --- |
| `upsertReminder` **(new)** | `service` | `calendar.write` | `create` | `{ userId, key, title (≤ 120), description (≤ 2000), date: "YYYY-MM-DD", time: "HH:MM", durationMinutes (5-120), timeZone, sourceMessageId: string \| null }` | `{ eventId, ref: { kind: "calendar:event", id }, created: boolean }` |
| `removeReminder` **(new)** | `service` | `calendar.write` | `delete` | `{ userId, key }` | `{ removed: boolean }` |

- Implementation in `src/lib/calendar/reminders.ts` **(new)**. `userId` must equal `ctx.viewer.userId` (a caller can only write the calendar of the user it acts for), else `forbidden`.
- `key` must match `^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{1,100}$` (no `@`, so it can never equal a real invitation UID). It is stored in `calendar_events.ical_uid`; Money Watch uses `money-renewal:<subscriptionId>`, one event per subscription that moves with the due date.
- The `calendar_events_ical_uid_idx` index on `(user_id, ical_uid)` is not unique, so the insert is `INSERT … SELECT … WHERE NOT EXISTS` on `(user_id, ical_uid)`, like `insertTriageJob`, followed by an update when it exists.
- Writes go through `emitCalendarWrites` (`src/lib/calendar/webhook-events.ts:23`), so `calendar.event.created`/`updated`/`deleted` webhooks and calendar search behave as for any event.
- Money Watch calls them with `moduleHost.invoke(ctx, "calendar", "upsertReminder", …)` only after `moduleHost.modules.isEnabledFor(ctx, owner, "calendar")`; a `module_disabled` or other failure is logged and never blocks the notice. The event is at 09:00 for 15 minutes in the owner's time zone on the due date, titled "Netflix renews ($17.99)" or "Netflix trial ends", with a description linking to `/money?subscription=<id>`.
- Undo of `create_subscription`, `delete_subscription`, turning the calendar reminder off and status `cancelled`/`expired` call `removeReminder`. Turning Money Watch or Calendar off leaves existing events in place (data stays).

## 12. The Subscriptions view

### 12.1 Page and guard

`src/app/(money)/layout.tsx` **(new)** calls `requireModulePage("money")` above the shell, with `export const dynamic = "force-dynamic"`, the pattern of `src/app/(import)/layout.tsx`, and renders `DashboardSectionShell`. The page is `src/app/(money)/money/page.tsx` **(new)**; components live in `src/components/money/` **(new)** with sibling `*-types.d.ts` and `*-utils.ts` files. The layout is added to the guarded-layout list in `tests/module-route-guard.test.mjs`.

### 12.2 Layout

| Area | Content |
| --- | --- |
| Header | "Subscriptions", an **Add subscription** button, a status filter (Active and trials, Cancelled and expired, All). |
| Totals | Monthly and yearly cost of `active` rows, one line per currency (no conversion): weekly × 52 / 12, monthly, quarterly / 3, yearly / 12; yearly is monthly × 12. Trials are listed as "after trials: +$x/month"; rows without an amount or cycle are counted as "n without a price". |
| Needs attention | Payment failed, trials ending within their reminder window, renewal dates that passed without a new invoice. |
| Upcoming renewals | Sorted by due date: vendor, plan, amount and cycle, "renews in 5 days (1 Nov)", status badge, "Increased from $14.99" or "Decreased from …" chip for 90 days after a change, "estimated" marker. |
| No date | Active rows without a renewal date. |
| Cancelled and expired | Collapsed. |
| Row menu | Edit, Reminder (Off, 1, 3, 7, 14 days before; Add to calendar), Mark as cancelled / active / expired, Cancel before … (§10.4), Remove. Every write shows the undo toast. |
| Detail drawer (`?subscription=<id>`) | Fields, the cancel link host, and the vendor history from `money_charges` (date, amount, outcome) with each message linked through its `mail:message` ref; a purged message shows "Message deleted". |

The add/edit dialog has more than a few fields, so its `DialogContent` gets `max-h-[calc(100vh-4rem)] overflow-y-auto`. Colours use the `blue-*` palette and semantic tokens so Kite, Classic and dark mode all work; the page is checked in all three (§20).

### 12.3 API routes

Every route below is **(new)**. Every method is wrapped in `withModule("money", …)` and calls `requireSessionUser` then `checkUser`. A row is visible only to its owner; anyone else gets 404. Run `npm run docs:generate` after adding the routes.

| Route | Purpose |
| --- | --- |
| `GET /api/money/subscriptions?status=` | `{ subscriptions, totals, migrationPending? }` |
| `POST /api/money/subscriptions` | Manual add (`create_subscription`); body is the dialog fields plus `mailboxId` and optional `messageId`; returns `{ subscription, actionId }` |
| `GET /api/money/subscriptions/[id]` | The row and its charges with resolved message refs |
| `PATCH /api/money/subscriptions/[id]` | `{ fields }` → `update_subscription`, `{ reminderDays, calendarReminder }` → variant `reminder`, `{ status }` → `set_subscription_status`; returns `{ subscription, actionId }` |
| `DELETE /api/money/subscriptions/[id]` | `delete_subscription`; returns `{ actionId }` |
| `POST /api/money/detect` | `{ messageId }` → the prefilled draft for "Track as subscription"; 404 without full access to the message's mailbox; writes nothing |
| `GET /api/money/badge` | `{ count }` |

Input validation is zod in `src/lib/money/api-schemas.ts` **(new)** with the same bounds as §5.4-§5.5 (dates within 2 years; manual entries may also be up to 5 years in the past for history).

## 13. Ownership, visibility and contacts

### 13.1 Owner

The owner of a detected subscription is the suggestion's reviewer: `mailbox_agent_settings.reviewer_user_id`, else the mailbox owner, as copied to `agent_jobs.reviewer_user_id` and `agent_suggestions.reviewer_user_id`. The step runs with the reviewer as viewer and matches against the reviewer's rows. Manual rows belong to the user who adds them.

### 13.2 Who sees what

Subscriptions are financial data, so the recommendation (§23, question 7) is **reviewer only**:

- Suggestions are listed today to every user with full access to the mailbox. The `subscription` kind declares `audience: "reviewer"` (§16 C4), so its cards, row badges and For you counts appear only for the reviewer, and only the reviewer can accept them (`moduleHost.suggestions.get` checks it).
- Rows, the view, search, refs, tools and webhooks are owner-only. Admins and the primary admin do not see other users' subscriptions in the UI; they are in admin backups like all other data (§18).

### 13.3 Contacts

Inbound delivery already upserts a contact for each sender. On accept, `moduleHost.contacts.find(ctx, ownerId, senderAddress)` **(new, §16 C10)** returns `{ id, displayName } | null`, and the row stores `contact_id`. Money Watch never creates or edits contacts. `contact:contact` refs do not resolve today, so the view shows the sender address with a link to search for its mail.

## 14. Refs, events, search, tools and scopes

| Surface | Money Watch contribution |
| --- | --- |
| Record refs | `money:subscription` resolved by `src/lib/money/refs.ts` **(new)**: label "Netflix · $17.99/month", `href: "/money?subscription=<id>"` (passes `isSameOriginPath`); unavailable for anyone but the owner, for a missing row, before 0063 and while the module is off. |
| Webhooks | `money.subscription.detected` when a row is created (accept or manual), payload `{ subscription: { ref, vendor, plan, amount, cycle, status, nextRenewalOn, trialEndsOn }, source: "suggestion" \| "manual", message: ref \| null }`. `money.subscription.renewal_due` from the cron, payload `{ subscription: {…}, due: { on, kind: "renewal" \| "trial_end", daysLeft } }`. Emitted with `moduleHost.emitWebhook` and the owner as viewer, so only the owner's webhooks receive them. |
| Search | Section "Subscriptions": owner rows whose vendor or plan matches (escaped `LIKE`), at most 10, as refs. |
| Assistant and MCP | `list_subscriptions` (§4) through `mcp:money-read`. Write tools are deferred (§23, question 19). |
| Activity | Labels from `actionLabels`; targets resolved through the generic module ref collection (§16 C9). |
| Scopes | Registry-wide as for every module: toggling never invalidates a key; creating a key with `mcp:money-read` while the module is off answers 400 `MODULE_DISABLED`. |

## 15. Gating: off means absent

| Surface | Install off or user restricted | Mechanism |
| --- | --- | --- |
| Sidebar item and count | Hidden; count not fetched | `nav-utils.ts` filters by enabled modules |
| `/money` | 404 | `requireModulePage("money")` in `src/app/(money)/layout.tsx` |
| `/api/money/*` | 404 (install: before auth; user: after `checkUser`) | `withModule("money", …)` |
| Detection | Not run; job note `module_disabled:money` | `runModuleTriageSteps` checks the reviewer |
| Existing cards, row badges, For you | Hidden | `hiddenSuggestionKinds` |
| Accept or undo of a Money Watch action | Refused with `module_disabled` | `answerSuggestion`, `undoModuleAction` |
| "Track as subscription" in the reader | Absent | message-menu slots list enabled modules only (C13) |
| Palette commands | Absent | Registry commands filtered by state |
| Cron | Install off: `module_disabled` (debug log). User restricted: that user's rows skipped and untouched | `invokeCapability`, `isEnabledFor` |
| Notices, webhooks | None emitted; event list hides the events; subscribing answers 400 `MODULE_DISABLED` | Module code does not run |
| Tools and search | Not listed; no search section | Registry filters |
| Refs | Unavailable label | `resolveRecordRefs` |
| Calendar reminders already created | Kept | Calendar data |
| Data | Kept | No hook deletes anything |

Turning the module back on restores everything; reminders inside their window fire on the next tick.

## 16. Core changes (generic)

None of these mention Money Watch. Each lands with unit tests, and each changes Calendar only where noted. File paths are at `b8afdb8`; every type, field, hook, event and key this table introduces (for example `CoreSuggestionKind`, `suggestionKindMeta`, `audience`, `triage.automatic`, `triage.capability`, `capabilities.modules`, `reopensSuggestion`, `ModuleNoticeNotification`, `kite:module-notice`, the `sidebar` placement, `count`, `useModuleNavCounts`, the `message-menu` slot and `scheduledTime`) is **(new)**.

| # | Change | Files | Notes |
| --- | --- | --- | --- |
| C1 | **Store and validate module-owned suggestion kinds.** `SuggestionKind` becomes `CoreSuggestionKind \| (string & {})` (same for the `agent_suggestions.kind` TypeScript enum); `STORED_KINDS` becomes core kinds plus `suggestionKindOwners`; `parseSuggestionPayload` falls back to the owning descriptor's input schema (`capabilityInputSchema`) instead of indexing `PAYLOAD_SCHEMAS` (an unknown kind throws a TypeError today) | `src/lib/agent/auto-read/suggestion-types.d.ts:1-2`, `suggestions.ts:9`, `suggestion-utils.ts:41-95`, `src/db/schema/agent-auto-read.ts:21` | Without it a `subscription` suggestion is planned and silently not stored. No migration (no SQL CHECK). Update `tests/agent-auto-read-modules.test.mjs:131` (`suggestionKindOwners`). |
| C2 | **Suggestion UI from client data.** `ClientModuleData.suggestionKindMeta` (new: `label`, `reason`, `badgePriority`, `icon`) drives `BLOCK_KINDS`, `FOR_YOU_KIND_LABELS`, `BADGE_PRIORITY`, `SUGGESTION_KIND_ORDER`, badge chips and `REASON_TEXT`; module kinds render through the existing `ModuleBlock` | `src/components/agent/suggestion-card-utils.ts:5`, `src/lib/agent/auto-read/for-you-utils.ts:4`, `suggestion-badge-utils.ts:4-7`, `src/components/agent/agent-activity-utils.ts`, `for-you-view.tsx:161` | Calendar adds its own meta; behaviour unchanged. |
| C3 | **Step-supplied titles.** Step output suggestions may carry `title` (≤ 120, control and bidi characters stripped by core); otherwise the kind's `label` | `src/lib/modules/shared-schemas.ts:38-68`, `module-steps-utils.ts`, `suggestion-utils.ts:78` (`STATIC_TITLES`) | `title` is NOT NULL today and `STATIC_TITLES` has no entry for a module kind. |
| C4 | **Reviewer-only kinds.** `suggestionKind.audience?: "mailbox" \| "reviewer"` (default `mailbox`); listing, row badges on `/api/messages`, For you counts and `loadForDecision` hide or refuse `reviewer` kinds for anyone but `reviewer_user_id` | `src/lib/modules/module-types.d.ts:163`, `src/lib/agent/auto-read/suggestion-visibility.ts`, `suggestion-api.ts:128`, `src/app/api/messages/route.ts` | Private financial data in shared mailboxes. |
| C5 | **Wider triage-step input.** `message.fromName`, `message.textExcerpt` (≤ 8 KB), `facts.automatic/noReply/list/spam`, `headers.listUnsubscribe/listUnsubscribePost/listId` from the already-loaded `readRawHeaders` map | `shared-schemas.ts:38-68`, `src/lib/agent/auto-read/module-steps.ts:45-77`, `triage-context.ts` (loads the headers at line 45 but does not return them yet) | No new R2 read; extra keys are stripped for Calendar. |
| C6 | **Automatic mail reaches opted-in steps.** `triage.automatic?: true` on a step. `triageMessageGate` keeps skipping `Auto-Submitted` mail unless an opted-in step's module is enabled for the reviewer; `processAgentTriageJob` then runs a steps-only pass for automatic mail (no model, no core kinds except phishing). Bulk, list and no-reply mail already pass the gate | `src/lib/agent/auto-read/schedule-utils.ts:22-35`, `schedule.ts`, `process.ts:81-145`, `src/lib/modules/module-types.d.ts:165` | Most receipts carry `Auto-Submitted: auto-generated`. Steps-only jobs count toward the daily job limit (§23, question 17). |
| C7 | **Steps run when the model is refused.** On `external_provider_not_allowed`, `rate_limited` or `spend_cap`, run module steps with `model: null`, store their suggestions, and record the model skip in the job note instead of skipping the whole job | `process.ts:102-104` (returned skips) and `process.ts:163-165` (`SpendCapReachedError`, `ExternalProviderNotAllowedError`) | Also lets Calendar invites through when the model is refused (§23, question 18). |
| C8 | **Per-mailbox module step switch.** `triage.capability?: string` names a key in a new `capabilities.modules` map (default `true`) in the mailbox capabilities JSON; `STEP_CAPABILITY` falls back to it; the automatic-reading settings list one switch per enabled module step from client data | `module-steps.ts:16,37-43`, `src/lib/agent/auto-read/settings-types.d.ts:3-10`, `settings-utils.ts:14` (`CAPABILITY_KEYS`), `src/components/agent/auto-read-settings.tsx` | Calendar keeps its existing `calendar` key. |
| C9 | **Module action types and Activity refs.** `AgentActionType` becomes core types plus `string` (module types validated against `ACTION_REGISTRY`); Activity collects `result.ref`/`after.ref` of any module action instead of `CALENDAR_ACTIONS`; `action.reopensSuggestion?: boolean` reopens the suggestion after an undo when no live action of that module remains | `src/lib/agent/auto-read/policy-types.d.ts:6`, `src/db/schema/agent-auto-read.ts`, `activity-ref-utils.ts:4`, `src/lib/agent/auto-read/activity.ts`, `execute.ts:323` | Matches module-platform §11.2's "core types plus string". |
| C10 | **ModuleHost additions** (below) | `src/lib/modules/host-types.d.ts`, `host.ts`, `host-services.ts` | Each checks `ctx.viewer` and, where a mailbox is named, `ctx.mailboxIds` or mailbox access. |
| C11 | **Module notices over realtime.** `RealtimePayload` gains `ModuleNoticeNotification`; the client toasts it and dispatches `kite:module-notice` | `src/lib/realtime/types.d.ts:27`, `src/lib/realtime/utils.ts`, `src/hooks/use-message-polling.ts:96`, `src/hooks/message-realtime-utils.ts` | Works on the Durable Object and the Node hub alike. |
| C12 | **Sidebar placement with a count.** `ModuleNavPlacement` gains `"sidebar"`; `ModuleNavItem.count?: { endpoint }` must start with one of the module's API prefixes (registry test); `dashboard-nav.tsx` renders enabled modules' sidebar items under For you with `NavLink count`, fetched by a generic `useModuleNavCounts` | `module-types.d.ts:21-34`, `src/lib/modules/nav-utils.ts`, `src/components/dashboard-nav.tsx`, `src/components/modules/client-registry.ts` (`NAV_ICONS` gains `WalletCards`) | |
| C13 | **Message menu slot.** A `message-menu` slot (manifest `messageSlots`, client data `messageSlots`) rendered by the reader's overflow menu through the same lazy client-chunk mechanism as `ComposerSlot`; the slot component receives `{ messageId, mailboxId }` only | `module-types.d.ts:68-77`, `src/components/compose/composer-slot.tsx` (shared loader), `src/components/message-actions/message-actions.tsx` | |
| C14 | **Cron input carries the tick time.** `runModuleCronTasks` passes `{ scheduledTime }` (ISO) instead of `{}`; there is no shared cron input schema, so Money Watch's own `remindRenewals` schema allows it as optional | `src/lib/modules/background-utils.ts:90` | Lets unit tests and the Miniflare `time` parameter drive the reminder clock. Import ignores it: its `resumeStalledImports` input is `z.object({})` (`src/lib/modules/import/schemas.ts:12`), which strips the key. |

ModuleHost additions (C10), all **(new)**:

```ts
type ModuleHost = ExistingModuleHost & {
	suggestions: {
		/** A suggestion of a kind the module owns, if the viewer may decide it (full access, and the reviewer for `audience: "reviewer"`). */
		get(ctx, moduleId, suggestionId): Promise<{ id; mailboxId; messageId; kind; status; payload: JsonValue; reviewerUserId } | null>;
		/** Marks an open suggestion of the module's kind accepted by the viewer and sends the quiet realtime ping. */
		decide(ctx, moduleId, suggestionId, status: "accepted"): Promise<boolean>;
	};
	actions: {
		/** executeAction as the viewer (initiator "user", permissions from mailbox access) for an action capability the module owns. */
		execute(ctx, moduleId, call: { capability: string; mailboxId: string; variant?: string; suggestionId?: string | null;
		                               messageId?: string | null; input: Record<string, JsonValue>; before?: JsonValue }):
			Promise<{ ok: true; actionId: string; result: JsonValue } | { ok: false; status: 403 | 404 | 409; error: string }>;
	};
	notify(ctx, moduleId, userIds: string[], notice: { notice: string; title: string; body?: string; href?: string }): Promise<void>;
	contacts: { find(ctx, userId, email): Promise<{ id: string; displayName: string | null } | null> };
	mail: ExistingMail & {
		getMessage(ctx, messageId, options?: { text?: { maxBytes: number }; headers?: ("list-unsubscribe" | "list-unsubscribe-post" | "list-id")[] }):
			Promise<(HostMessageView & { fromName: string | null; textExcerpt?: string | null; headers?: Record<string, string | null> }) | null>;
		/** At most 5 earlier received messages from one sender in a mailbox in ctx.mailboxIds, newest first, with excerpts ≤ 4 KB. */
		recentFromSender(ctx, { mailboxId, sender, before, sinceDays, limit }): Promise<(HostMessageView & { textExcerpt: string | null })[]>;
	};
};
```

`notify` rejects an `href` that fails `isSameOriginPath`, caps `title` at 120 and `body` at 300 characters, and sends only to users for whom the module is enabled. `actions.execute` refuses a capability whose action descriptor belongs to another module.

Tests and lists that hard-code the four modules gain `money` (§17, steps 13 and 14): `tests/module-registry.test.mjs` (`IDS`, surface counts, command list, manifest assertions), `module-imports` (`MODULE_IDS`, `MODULE_CODE` gains `src/lib/money`), `module-route-guard` (layouts), `module-state`, `agent-chat-tools`, `module-admin`, `module-webhooks`, `module-commands`, `module-search-lifecycle`, `module-composer-slots`, `module-nav`, `module-jmap`, `backup-module-tables`, `module-capabilities`, `module-migration` ("0062 last" becomes "0063 last"), `src/lib/modules/client-data/module-ids.ts`, `e2e/support/modules.ts` and the four-module assertions in `e2e/27-modules.spec.ts`.

## 17. Module files

Following the 14 steps of "Adding a builtin module" (`docs/modules.md:68-87`). Every file named here is **(new)** except the existing lists and registries it is added to:

| Step | Files |
| --- | --- |
| 1 Id | `ModuleId` in `src/lib/modules/module-types.d.ts:1`; `MODULE_IDS` in `src/lib/modules/client-data/module-ids.ts` (after `import`) |
| 2 Client data | `src/lib/modules/client-data/money.ts`; `CLIENT_MODULES` in `client-data/index.ts` |
| 3 Manifest | `src/lib/modules/money/manifest.ts`; `MODULE_MANIFESTS` in `registry.ts` |
| 4 Schemas | `src/lib/modules/money/schemas.ts` |
| 5 Descriptors | `src/lib/modules/money/capabilities.ts`; `MODULE_CAPABILITIES` in `capability-registry.ts` |
| 6 Handlers | `src/lib/modules/money/server.ts`; `SERVER_MODULES` in `server-registry.ts` |
| 7 Core services | Only `moduleHost` (§16 C10) |
| 8 Record kinds | `money:subscription` in `RecordKind`; `src/lib/money/refs.ts` |
| 9 Client code | `src/components/modules/money/client.ts` (`suggestionCards.subscription` `{ Block, Answered }`, the message-menu slot component, the add dialog loader) in `MODULE_CLIENTS` with the inline `typeof window` check; `NAV_ICONS.WalletCards` |
| 10 Composer slots | None (a `message-menu` slot instead, C13) |
| 11 Cron | `cronTasks` entry plus the `remindRenewals` descriptor |
| 12 Guards | `src/app/(money)/layout.tsx`, `src/app/(money)/money/page.tsx`, `src/app/api/money/**/route.ts` with `withModule`; `npm run docs:generate` |
| 13 Tests | §20 |
| 14 Data and backups | `src/db/schema/money.ts`, `drizzle/migrations/0063_add_money_watch.sql`, journal, backup lists (§8) |

Implementation in `src/lib/money/` **(new)**: `detect.ts` (step handler: matching, history, PDF orchestration), `detect-utils.ts`, `keywords-utils.ts`, `amount-utils.ts`, `date-utils.ts`, `vendor-utils.ts`, `cancel-link-utils.ts`, `pdf-text-utils.ts`, `text-utils.ts`, `totals-utils.ts`, `reminder-utils.ts` (window and due-date maths per time zone), `actions.ts` (execute and undo for the four action capabilities), `answer.ts`, `reminders.ts` (cron), `subscriptions.ts` (queries), `api-schemas.ts`, `refs.ts`, `search.ts`, `tools.ts`, `webhook-events.ts`, `types.d.ts`. Every `*-utils.ts` is added to `gated` in `scripts/quality/coverage-config.json`. Each file stays under 500 lines and each function under complexity 20 (`quality:check` baselines). Calendar gains `src/lib/calendar/reminders.ts` plus two descriptors and handlers in `src/lib/modules/calendar/`.

## 18. Security and privacy

- **Untrusted input.** Mail is attacker-controlled. Detection is regex and arithmetic over bounded text (subject ≤ 300, excerpt ≤ 8 KB, history excerpts ≤ 4 KB, PDF text ≤ 64 KB) with linear-time patterns. No model is involved, so there is no prompt-injection path in v1; the hostile corpus in `tests/fixtures/agent-injection/` gains receipt-shaped cases checked by the unit tests (an "invoice" asking to add a link, oversized amounts, far-future dates, bidi vendor names).
- **Links.** The only stored URL is the `https` `List-Unsubscribe` link with no IP literal, local hostname or credentials. It is never fetched or POSTed by Kite and opens only on a click with `noopener,noreferrer`, after showing its host. Body links are never used. Vendor and plan text is rendered as text, never HTML.
- **Phishing and spoofing.** Phishing-flagged and spam mail produce no card; unauthenticated senders get the "Unverified sender" warning; the amount and vendor on the card are what code extracted, never model text.
- **Access.** Rows are owner-only in every surface (API 404, refs unavailable, search, tools, webhooks to the owner's own endpoints). Cards are reviewer-only (C4). Accept and edits need `manage` on the audit mailbox. The calendar service writes only the viewer's own calendar.
- **Stored data.** Vendor, plan, amounts, dates, the cancel link and links to messages. No card numbers: the detector does not extract digits other than amounts and dates, and stores no excerpt. `docs/privacy.md` ("What is stored where") and `docs/pii-handling.md` ("Storage and scope") gain the two tables. Account deletion cascades; message deletion keeps the history amount but drops the link; turning the module off keeps everything. Admin backups contain the tables like every other user data, and restore follows §8.
- **Logs.** Structured logs (`src/lib/logger.mjs`) carry ids and codes only, never vendor, amounts, dates or URLs. Prompts are not involved.
- **Spend.** v1 makes no model call and adds no spend. C6 and C7 add triage jobs for automatic mail but no model requests; steps-only jobs count toward the per-mailbox daily job limit.

## 19. Both runtimes

| Concern | Workers | Node/Docker |
| --- | --- | --- |
| Migration | Admin route, banner or `AUTO_APPLY_MIGRATIONS=1` | Applied at start (`server/runtime/migrate.ts`) |
| Cron | `scheduled` → `runModuleCronTasks` | `server/runtime/scheduler.ts`, no catch-up; the claim and the ±1-day window make missed or doubled ticks harmless |
| Notices | `RealtimeHub` Durable Object, reachable from `scheduled` | In-process hub in the same process as the scheduler |
| PDF inflate | `DecompressionStream` | `DecompressionStream` (Node 22 global) |
| Triage | `AGENT_QUEUE` | In-process queue |

No new binding, queue, secret or provider. `wrangler.jsonc` is unchanged.

## 20. Test plan

### 20.1 Unit (`node --test`, no bindings)

| File | Covers |
| --- | --- |
| `tests/money-detect.test.mjs` **(new)** | Signals and threshold; one-off receipts rejected; amounts (separators, minor digits, symbols, `$` disambiguation, bounds); dates (formats, day-first rules, 2-year bound, no-year rollover); cycles and inferred cycles; vendor and vendor key (processors, public suffixes); payment-failed; titles; hostile inputs; phishing and spam skips. |
| `tests/money-cancel-link.test.mjs` **(new)** | `List-Unsubscribe` parsing: https kept, http/mailto/IP/localhost/credentials dropped, one-click only for the exact RFC 8058 value. |
| `tests/money-pdf.test.mjs` **(new)** | Text from small fixture PDFs (plain and Flate), encrypted skipped, truncated skipped, inflate and stream caps, time cap. |
| `tests/money-reminders.test.mjs` **(new)** | Due-date choice (trial versus renewal), window per time zone across DST, claim idempotency, missed reminders claimed silently, per-user restriction leaves rows untouched, calendar off skips the event, failures do not stop the loop (bundled with a SQLite database). |
| `tests/money-module.test.mjs` **(new)** | Step handler end to end on fixtures; answer service (track, update, mark urgent, stale suggestion, wrong reviewer); actions execute/undo/authorize idempotent by `actionId`; delete snapshot restore; refs owner-only; search; `list_subscriptions`; webhooks emitted with the owner. |
| `tests/money-migration.test.mjs` **(new)** | `copyMigrationsBefore(scratch, 63)`: pre-0063 backup restores after 0063 with empty tables; post-0063 round-trip; FK order (`users`, `mailboxes`, `contacts`, `messages`, `calendar_events` before `money_subscriptions` before `money_charges`); `mail` group membership; pre-0063 database reads as "nothing yet". |
| `tests/calendar-reminders.test.mjs` **(new)** | `upsertReminder` insert, update, no duplicate under repeated calls, key validation, `userId` must be the viewer; `removeReminder`; webhooks emitted. |
| Core (C1-C14) | `tests/agent-auto-read-modules.test.mjs` (stored module kind, payload fallback, step title, audience, steps-only automatic job, steps after a refused model, mailbox module switch, reopen on undo, Activity refs), `tests/module-queue-cron.test.mjs` (`scheduledTime`), registry tests for `sidebar`/`count`/`messageSlots`, realtime payload test, host service tests. |

Coverage: every new `*-utils.ts` is gated (branches ≥ 70%, functions ≥ 80% per file) without lowering the aggregate (branches ≥ 90%).

### 20.2 End to end

New `e2e/28-money-watch.spec.ts` **(new)**, serial (it restores a backup it takes), using its own account from `createSignedInAccount` with autonomy `suggest`, mail delivered through `deliverInbound` with `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted` and `Authentication-Results` headers, and the cron triggered with `GET /cdn-cgi/handler/scheduled?cron=*/5%20*%20*%20*%20*` (polling for the effect). Realtime frames are recorded with the socket recorder pattern of `e2e/26-one-time-code.spec.ts:84`. Assertions use unique tokens, never the seeded billing-mailbox messages (such as the received "Invoice address update"), which the seed inserts directly, so they are never triaged.

1. **Detects and tracks with undo:** an automatic invoice ("$17.99/month, renews …") produces a `subscription` card with the expected title in the reader and For you; Track creates the row (API and view), Activity shows "Started tracking a subscription", Undo removes the row and reopens the card.
2. **Second invoice updates and flags the price change:** a later invoice at $19.99 produces "now $19.99/month, up from $17.99"; accepting updates the renewal date and shows "Increased from $17.99".
3. **Payment failed:** the card marks the row urgent; it appears under Needs attention and in the badge.
4. **Manual add:** by hand from `/money`, and from a message through "Track as subscription" with the prefilled cancel link; both undoable.
5. **Renewal nudge:** a row renewing in 2 days with 3 reminder days; the cron tick produces one `module_notice` frame and toast, badge count 1, and a calendar event "… renews" on the due date; a second tick produces no second notice or event.
6. **Calendar off for the user:** the reminder still notifies, no calendar event is created, and the row keeps working.
7. **The view:** lists items in due order with totals, edits a reminder (Off → 7 days), "Cancel before …" opens a popup on the header's https URL (no server request to it, checked with a route recorder), then "Mark as cancelled" moves it to Cancelled.
8. **Cancel link only from the header:** a body link with no header gives no cancel link; an `http:` header gives none.
9. **Reviewer only:** a user with full shared access sees no Money Watch card and gets 404 accepting it.
10. **Off means absent:** install off, then user restricted: nav item, `/money` (404 page), `/api/money/*` (404), cards, the message menu item, palette commands, `list_subscriptions`, search section and webhook events are gone; the cron tick leaves rows untouched and sends no notice; on again restores all.
11. **Model refused still detects:** with the external provider not allowed, a personal non-bulk receipt still yields the card (C7).
12. **Backup round-trip:** both tables in `includedTables`, restore brings rows back.
13. **Kite, Classic and dark mode:** the view, the card and the dialog render without overflow in all three.

`e2e/27-modules.spec.ts` gains `money` in its module lists and counts (session list, Modules page, `toHaveCount(5)`, `ALL_MODULES_OFF`, signed-out 401 for `/api/money/subscriptions`, the mail-only install and backup tests) and an `offThenOn` case for Money Watch nav, page and API. `e2e/support/modules.ts` gains the id, `e2e/global-setup.ts` adds `/money` to `WARM_UP_ROUTES`, and `e2e/README.md` gains the new file. No `e2e/timings.json` entry is needed until the first CI run.

### 20.3 Manual

`npm run dev` with `npm run db:seed`, deliver a few synthetic receipts, check the card, the view, the toast and the calendar event in Kite, Classic and dark mode, and run `npm run check:mission` (validate-kite skill) before review. Check the bundle budget after `npm run build`.

## 21. Documentation

| Document | Change |
| --- | --- |
| `docs/modules.md` | "The four modules" becomes five with a Money Watch row; what off does for it; the database update note names 0063. |
| `docs/assistant.md` | The `subscription` suggestion kind, reviewer-only cards, detection on automatic mail, the per-mailbox switch. |
| `docs/specs/auto-agent.md` | Lines 20, 41, 80-82, 199, 252, 275 and 410-418: module kinds, the cancel-link rule, steps-only jobs. |
| `docs/specs/module-platform.md` §11.2 | The wider step input, `triage.automatic`, `triage.capability`, `audience`, `reopensSuggestion`, step titles, the new host services, `sidebar` placement and `message-menu` slots. |
| `docs/privacy.md`, `docs/pii-handling.md` | The two tables, owner-only access, deletion behaviour (contract docs: paths are checked). |
| `CLAUDE.md` | Modules and automatic-reading sections (five builtin modules, suggestion kinds, backups bullet). |
| `CHANGELOG.md` | Unreleased: apply migration 0063; **Money Watch** under Added with a link to [/money](/money). |
| `ROADMAP.md`, `docs/roadmap-complete-suite.md` | Milestone 18 marked shipped with the PR, noting deferred model extraction. |
| `e2e/README.md` | Row for `28-money-watch.spec.ts`; `27-modules` lists five modules. |
| `docs/specs/drive-storage.md` | Its planned 0063 and 0064 move to the next free numbers. |
| `docs/api-inventory.md`, `src/lib/metrics-routes.generated.json` | Regenerated by `npm run docs:generate`. |

## 22. Delivery plan

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **M1: core generalisation and the empty module** | C1, C2, C3, C5, C8, C9, C14; module id, client data, manifest, descriptors with stub handlers, `money_subscriptions` and `money_charges`, migration 0063, backup lists, every hard-coded module list | `npm run check` green; registry, import, route-guard, migration and backup tests pass; Admin → Modules shows five modules; `27-modules` passes with five in its lists and counts (its Money Watch `offThenOn` case and the signed-out `/api/money/subscriptions` check are added once those routes exist, M2-M3); Calendar behaviour unchanged. |
| **M2: detection and tracking** | Deterministic detector (§5, without PDF), C4, C6, C7, C10, C13; step, card, answer service, the four actions with undo and reopen, price change, payment failed, manual add (API, dialog, message menu), contacts link, refs, `money.subscription.detected`, Activity | e2e cases 1-4, 8, 9 and 11, asserted through the card, the API and Activity (their `/money` view, "Needs attention" and badge assertions are added in M3); unit tests for detector, cancel link and module handlers. |
| **M3: the view and the nudges** | `/money` view, totals and history; C11, C12; `remindRenewals`; Calendar `upsertReminder`/`removeReminder`; badge; cancel button; `money.subscription.renewal_due`; search; `list_subscriptions` | e2e cases 5-7, 10, 12 and 13; reminder and calendar unit tests; checked in Kite, Classic and dark mode. |
| **M4: attachments, hardening and docs** | PDF extraction (if kept, §23 question 6), hostile corpus cases, performance check of the step on a large mailbox, documentation (§21), CHANGELOG, timings refresh | `npm run check:mission` green locally; bundle within budget; docs check passes. |

Each milestone is one or more commits on `mission/money-watch`; nothing is pushed to `main`.

## 23. Open questions

Each has a recommended default; the implementation follows the default unless the reviewer decides otherwise.

1. **Module id.** Default: `money`. Consequence: grants `money.*`, kind `money:subscription`, routes `/money` and `/api/money`, events `money.subscription.*`. Choosing `subscriptions` gives awkward names (`subscriptions:subscription`) and clashes with webhook and SNS subscriptions; `moneywatch` is long. Renaming later means changing scopes stored on keys, so decide now.
2. **`defaultEnabled`.** Default: `true`. Consequence: existing installs get the module on after the deploy, but nothing happens until a mailbox uses `suggest` and the user clicks Track. `false` would need the registry assertion (`tests/module-registry.test.mjs:68`), the Modules page copy and the e2e defaults changed, and most users would never find it.
3. **Migration numbering with drive storage.** Default: Money Watch takes 0063 (journal `idx` 66) because it runs first; drive storage's planned 0063/0064 move to the next free numbers when it starts. Consequence: `tests/migration-order.test.mjs` keeps passing; `docs/specs/drive-storage.md` lines 5, 320, 619 and 627 are updated in M4.
4. **Table names.** Default: `money_subscriptions` and `money_charges`, not the roadmap's `subscriptions`. Consequence: tables are namespaced like the module and cannot be confused with webhook subscriptions; the roadmap text is updated. The second table is what makes vendor history and price history possible.
5. **Model extraction in v1.** Default: no; deterministic only, using `model.category === "receipt"` as a weak signal when the model ran anyway. Consequence: no spend or external-provider change, and the roadmap's validated `subscription` object becomes a follow-up using the descriptor-declared schema fragment in §5.7. Detection quality depends on the keyword lists and amount parsing.
6. **PDF extraction in v1.** Default: yes, best-effort and bounded (§6), in M4. Consequence: invoices whose body only says "your invoice is attached" are found when the PDF has plain text; scanned PDFs and images are not. Dropping it shortens M4 and leaves those to manual add.
7. **Who sees subscriptions.** Default: cards for the reviewer only (C4); rows owner-only everywhere. Consequence: users sharing a mailbox do not see each other's spending; a shared support mailbox's receipts go to its reviewer. The alternative (every full-access user sees the card, the accepter owns the row) contradicts the roadmap's "the owner is the mailbox's reviewer".
8. **Event names.** Default: `money.subscription.detected` and `money.subscription.renewal_due`, prefixed with the module id like `calendar.event.created`. Consequence: they differ from the roadmap's `subscription.detected` and `subscription.renewal.due`; whatever is chosen is a public webhook contract. Adding `money.subscription.updated` and `money.subscription.cancelled` is a cheap follow-up.
9. **Are manual edits, status changes and cancellations audited in `agent_actions`?** Default: yes, all of them (§9.1). Consequence: every change is undoable and listed in Activity, as the roadmap's "every write is audited" asks, at the cost of needing a managed mailbox for the audit row (§9.5). The alternative, `audit_logs` only for manual edits, has no undo.
10. **`mailto:` List-Unsubscribe links.** Default: ignored in v1; only `https` links are stored. Consequence: some vendors show "No cancel link"; a `mailto:` link would open the user's own composer, which is safe but sends mail from their address, so it should be a deliberate later choice (a prefilled draft, never an automatic send).
11. **Server-side RFC 8058 one-click POST.** Default: no; the link only opens in the browser. Consequence: no SSRF surface and no request Kite makes on the user's behalf; the auto-agent spec's line 82 mentions a click-triggered POST, which stays unbuilt. A later change would need an SSRF guard, DKIM coverage of the header and a user click.
12. **Per-mailbox switch for the step.** Default: yes, through the generic `capabilities.modules` map (C8), on by default. Consequence: a user can keep automatic reading for a work mailbox without Money Watch reading it. Without it, the module switch is all-or-nothing per user.
13. **Badge placement.** Default: a new generic `sidebar` placement under For you with a count from `/api/money/badge` (C12). Consequence: one core change that later modules reuse; the alternative (only the For you count) shows nothing for reminders, which are not suggestions.
14. **Renewal invoices for tracked subscriptions without a click.** Default: no; each renewal invoice is a card ("Netflix renewed, next on 1 Dec. Update it?") until an Act level ships. Consequence: monthly vendors produce a monthly card. A per-row "keep up to date automatically" setting is the follow-up once agent-initiated module actions are allowed.
15. **Failed payment flips to urgent without a click.** Default: no; the card is high priority and accepting marks the row urgent. Consequence: consistent with suggest-only; the roadmap's "flip the item to urgent" needs one click.
16. **Calendar reminders.** Default: on per item (`calendar_reminder` default true) when Calendar is on for the owner, created by the cron at the start of the reminder window, recorded with `moduleHost.audit` rather than `agent_actions`. Consequence: the e2e can check the event; users who dislike them turn them off per item. Auditing them in `agent_actions` would need an agent-initiated action type the executor does not allow at autonomy `suggest`.
17. **Steps-only jobs and the daily limit.** Default: they count toward the per-mailbox daily job limit (default 200). Consequence: a flood of automatic mail cannot run unbounded steps; on a very busy mailbox the limit is reached sooner and later receipts that day are not checked.
18. **Running module steps when the model is refused (C7).** Default: yes, for every module. Consequence: Calendar invites are also detected when the external provider is not allowed, rate limited or over its spend cap, which is a visible behaviour change for Calendar and needs a CHANGELOG line.
19. **Assistant write tools and REST scopes.** Default: read-only `list_subscriptions` and `mcp:money-read` only; no `apiKeyScopes`. Consequence: the assistant can answer "what renews this week" but not change a reminder; writes stay in the UI where undo is shown.
20. **Ambiguous `$`.** Default: USD unless a qualifier or code is on the same line. Consequence: Canadian or Australian vendors that print a bare `$` are stored as USD until the user edits the currency.
21. **Totals across currencies.** Default: one total per currency, no conversion. Consequence: no exchange-rate source or network call; users with mixed currencies see several lines.
22. **Keyword languages.** Default: English, Dutch, German, French and Spanish in `keywords-utils.ts`. Consequence: receipts in other languages are found only through the cycle, renewal and recurring signals; more lists are data-only additions.
23. **Undoing a reminder change after the reminder fired.** §9.1 says undoing "Change reminder" restores the setting and the cron recreates the event if due, but §10.1 skips a row whose `last_reminded_for` already equals the due date, so the calendar event is not recreated. Default: the undo of a reminder change also re-runs the Calendar `upsertReminder` service directly for that row (no second notice, `last_reminded_for` unchanged). Consequence: the event comes back without a duplicate notification; clearing `last_reminded_for` instead would be simpler but sends the notice twice.
