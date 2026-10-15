# Spec: Money Watch (subscription tracking as a builtin module)

Status: Approved 2026-10-14 (with the decisions in §23), for a Factory Mission on `mission/money-watch`. Written against `main` at `b8afdb8`. This mission claims migration 0063 (journal `idx` 66). The parallel `mission/attachments-once` ([storing attachments once](attachments-once.md)) takes 0064 or later, and [drive storage](drive-storage.md)'s planned 0063 and 0064 move to the next free numbers after both; whichever of Money Watch and attachments-once merges second rebases its migration number, journal `idx` and the "last migration" assertions in `tests/module-migration.test.mjs` (§7.3, §23, question 3). Scope: Roadmap milestone 18 ([complete suite](../roadmap-complete-suite.md#milestone-18-subscriptions-money-watch)). Money Watch is the first new module on the shipped [module platform](module-platform.md) and follows "Adding a builtin module" in [Modules](../modules.md); it adds no registry, helpers or infrastructure of its own. Everything marked **(new)** is an API, field or file this spec proposes; everything else exists at `b8afdb8`.

## 1. Summary

Most people pay for more subscriptions than they remember, and the evidence is already in their mailbox: receipts, invoices, "your trial ends" and "payment failed" mail. Money Watch reads that mail during automatic reading, offers to track what it finds, and reminds the user before something renews.

- **Detection** is a `triage_step` capability. It is deterministic first (subject, sender and body patterns, amounts, cycles and dates, attachments, a recurring sender and amount). When a message looks like a receipt but the detector left fields empty, the step asks for a small extraction from the existing triage model call through a generic, descriptor-declared model extension, and validates it in code (§5.7). It produces at most one `subscription` suggestion per message: "Netflix $17.99/month, renews 1 Nov. Track it?".
- **Tracking** writes a row in the module's own table only when the user accepts, through `agent_actions` (`create_subscription`) with undo. Later invoices from the same vendor offer to update the row and flag price changes. Users can also add a subscription by hand or from any message.
- **The document ledger** keeps one row per money document (invoice, payment receipt, credit note, refund, failed payment) linked to a tracked subscription, with its amount, date, the period it covers when stated, its source message and a reference to the attachment that is the document (§7.2). It is written only by the same accepted, undoable actions, or by hand from any message, and it gives each vendor's history and a "paid in the last 12 months" total per currency in which credits and refunds reduce the total (§12.2). Attachments are referenced, never copied. Filing those attachments into Drive is a follow-up for after Drive ships (§24); nothing in this mission calls Drive.
- **Nudges** come from a module cron task: a realtime notice, a count on the Subscriptions nav item and, when Calendar is on for the user, a calendar reminder created through a new Calendar `service`. "Cancel before 1 Nov" opens the sender's `List-Unsubscribe` link in the browser on a click, never from the server.
- **The Subscriptions view** at `/finance` lists upcoming renewals first, with monthly and yearly totals, the 12-month paid total, each vendor's documents linked to their mail and attachments, editing, status changes and per-item reminders.

Design principles:

1. **Off means absent.** With the module off for the install or for a user there is no nav item, card, cron work, tool, search section or event; pages and API answer 404; data is kept.
2. **Deterministic first; the model only fills gaps.** Billing mail is almost always automated, bulk or no-reply, so today's `needsModel` (`src/lib/agent/auto-read/facts-utils.ts:174`) skips it. The step's deterministic `wantsModel` hint requests the existing tool-less triage call only for receipt-like mail the detector could not complete, under every existing gate (autonomy, kill switch, external opt-in, daily and rate limits, spend caps). Model output is validated in code, never trusted, loses every conflict with a confident deterministic value and never supplies the cancel link (§5.7).
3. **Suggest only.** Only autonomy `off` and `suggest` can be saved today (`autonomyError`, `src/lib/agent/auto-read/settings-utils.ts:64`). No subscription is tracked or changed, no document is recorded in the ledger, and no calendar event is created, without a user decision; tracking a row (with its per-item calendar reminder, on by default) is that decision, and the cron only updates reminder bookkeeping on tracked rows (§10.1).
4. **Every user decision is audited and reversible** in `agent_actions`, including manual edits.
5. **The cancel link comes only from the `List-Unsubscribe` header**, never from the body, an attachment or a model, and it only opens on a click.
6. **No Money Watch code in core.** Every core change in §16 is generic ("a module-owned suggestion kind", "a module sidebar item", "a module model extension"), so the next module (alerts, bills) reuses it. `tests/module-imports.test.mjs` keeps enforcing the boundary.

Non-goals for this milestone: one-off purchases and general expense tracking (a receipt with no tracked or detectable subscription records nothing; this is an advanced, later feature, §23 Decisions, item 5), filing documents into Drive (a follow-up, §24), bank or card connections, currency conversion, automatic tracking without a click (waits for an Act level), server-side unsubscribe or cancellation requests, OCR of image receipts, any model request other than the one existing triage call (the module never calls a model itself, §5.7), the assistant suggesting "enable Money Watch" while it is off (milestone 19, item 5), REST `/api/v1` endpoints and write tools for the assistant.

## 2. Module identity

| Field | Value | Why |
| --- | --- | --- |
| Module id | `finance` | Decided (§23). Single word like the existing ids; it reads naturally in every derived name (below) and leaves room for receipts, invoices and bills later. `subscriptions` would give `subscriptions:subscription` and clashes with webhook and SNS "subscriptions"; a two-word id is long and unlike the other ids. |
| Display name | "Money Watch" | From client data `name`; the nav item is labelled "Subscriptions". |
| `runtime` | `"builtin"` | |
| `dependsOn` | `[]` | Calendar is optional: reminders degrade when it is off (§11). A dependency would force Calendar on for every Money Watch user. |
| `defaultEnabled` | `true` | Detection only runs where the mailbox owner already turned automatic reading to `suggest`, and nothing is stored without a click, so turning it on for existing installs surprises nobody. It also keeps the registry assertion `defaultEnabled === true` (`tests/module-registry.test.mjs:68`). See §23, question 2. |
| Pages | `/finance` | Route group `src/app/(finance)/`. |
| API prefix | `/api/finance` | Session auth only, no public routes. |
| Record kind | `finance:subscription` | |
| Grants | `finance.read`, `finance.write` | |
| MCP scope | `mcp:finance-read` (`mailboxBound: false`) | Data is per user, not per mailbox. |
| REST key scopes | none in v1 | No `/api/v1` surface yet. |
| Webhook events | `finance.subscription.detected`, `finance.subscription.renewal_due` | Decided (§23): the `<id>.<record>.<event>` pattern of `calendar.event.created`, replacing the roadmap's unprefixed names. |
| Suggestion kind | `subscription` | New. The reserved `receipt` kind stays for "file under Receipts" ([auto-agent spec](auto-agent.md) line 80). |
| Tables | `finance_subscriptions`, `finance_charges` (the document ledger, §7.2) | Namespaced by module id; the roadmap says `subscriptions` (§23, question 4). |
| Implementation | `src/lib/finance/` | Module directory `src/lib/modules/finance/` holds only the four platform files. |

Why `finance` and not a name tied to subscriptions: the module owns the user's financial mail (subscriptions now; receipts, invoices and bills later), and every derived name reads naturally (`/finance`, `finance:subscription`, `finance.subscription.detected`). The later read-only portfolio (roadmap milestone 24) is expected to be its own module with id `portfolio` rather than part of `finance`: the two share no data, have different privacy rules and depend on different infrastructure, so they keep separate owner switches.

## 3. Manifest

`src/lib/modules/finance/manifest.ts` **(new)**, listed in `MODULE_MANIFESTS` (`src/lib/modules/registry.ts`) after `import`. Client-safe data only.

```ts
import { financeClientData } from "../client-data/finance";
import type { ModuleManifest } from "../module-types";

export const financeManifest: ModuleManifest = {
	id: "finance",
	name: financeClientData.name, // "Money Watch"
	description: "Finds subscriptions in receipts and invoices, keeps their invoices, payments and refunds, and reminds you before they renew.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/finance" }],
	apiPrefixes: [{ prefix: "/api/finance" }],
	nav: financeClientData.nav,
	commands: financeClientData.commands,
	composerSlots: [],
	messageSlots: financeClientData.messageSlots, // (new) §16, C13
	recordKinds: [{ kind: "finance:subscription", label: "Subscription", unavailableLabel: "Subscription" }],
	webhookEvents: [
		{ value: "finance.subscription.detected", label: "Subscription detected", hint: "A subscription was added to Money Watch" },
		{ value: "finance.subscription.renewal_due", label: "Subscription renewal due", hint: "A tracked subscription renews or its trial ends soon" },
	],
	grants: [
		{ grant: "finance.read", label: "Read subscriptions" },
		{ grant: "finance.write", label: "Add, change and remove subscriptions and their documents" },
	],
	mcpScopes: [{ scope: "mcp:finance-read", label: "Read subscriptions", grants: ["finance.read"], mailboxBound: false }],
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
		record_document: "Recorded a subscription document",
		"record_document:invoice": "Recorded an invoice",
		"record_document:payment": "Recorded a payment",
		"record_document:credit": "Recorded a credit note",
		"record_document:refund": "Recorded a refund",
		delete_document: "Removed a subscription document",
	},
	reasonTexts: {
		subscription: "The message looks like a subscription receipt, invoice or renewal notice",
		subscription_price_change: "The amount differs from the tracked subscription",
		subscription_payment_failed: "The message says a subscription payment failed",
		subscription_trial: "The message mentions a free trial ending",
		subscription_refund: "The message is a refund or credit note for a tracked subscription",
		subscription_check_amount: "The message could be read two ways; check the amount before tracking",
		"module_disabled:finance": "Money Watch is turned off",
		migration_pending: "The database update for Money Watch has not been applied yet",
	},
};
```

Client data, `src/lib/modules/client-data/finance.ts` **(new)**, added to `CLIENT_MODULES`:

```ts
export const financeClientData = {
	id: "finance",
	name: "Money Watch",
	nav: [
		{
			id: "finance.subscriptions",
			label: "Subscriptions",
			href: "/finance",
			icon: "WalletCards", // needs a NAV_ICONS entry, src/components/modules/client-registry.ts
			placement: "sidebar", // (new) §16, C12
			count: { endpoint: "/api/finance/badge" }, // (new) §16, C12
			keywords: ["finance", "money", "subscriptions", "renewals", "bills", "trials"], // "money": users search for the display name
			order: 20,
		},
	],
	commands: [
		{ id: "finance.open", moduleId: "finance", label: "Open Subscriptions", description: "Show tracked subscriptions and renewals", group: "Money Watch", target: { type: "route", href: "/finance" }, effect: "navigate" },
		{ id: "finance.add", moduleId: "finance", label: "Add a subscription", description: "Track a subscription by hand", group: "Money Watch", target: { type: "route", href: "/finance?add=1" }, effect: "navigate" },
	],
	messageSlots: [ // (new)
		{ id: "finance.track-message", slot: "message-menu", order: 50, label: "Track as subscription" },
		{ id: "finance.add-document", slot: "message-menu", order: 51, label: "Add to a tracked subscription" }, // §9.4
	],
	suggestionKinds: ["subscription"],
	suggestionKindMeta: { subscription: { label: "Subscription", reason: "Looks like a subscription", badgePriority: 40, icon: "WalletCards" } }, // (new) §16, C2
	keyScopes: { mcp: [{ scope: "mcp:finance-read", label: "Read subscriptions", description: "List tracked subscriptions and renewals", mailboxBound: false }], api: [] },
} satisfies ClientModuleData;
```

## 4. Capability descriptors

`src/lib/modules/finance/capabilities.ts` **(new)**, generated from zod schemas in `src/lib/modules/finance/schemas.ts` **(new)** with `describeCapability`, added to `MODULE_CAPABILITIES`. Handlers in `src/lib/modules/finance/server.ts` **(new)**, added to `SERVER_MODULES`; each one only calls into `src/lib/finance/`.

| Name | Surfaces | Scopes | Effect | Declaration details |
| --- | --- | --- | --- | --- |
| `detect` | `triage_step` | `finance.read` | `read` | `triage: { order: 20, automatic: true, capability: "subscriptions", model: { … } }` (`automatic`, `capability` and `model` new, §16 C6, C8 and C15; the `model` literal is in §5.7), `timeoutMs: 15000` |
| `wantsModel` | `service` | `finance.read` | `read` | Named by `triage.model.wantsModel`; called by core before the triage model call with the step input (`model: null`) and returns `{ wantsModel: boolean }` (§5.7.2). Pure, no database read, `timeoutMs: 2000`. |
| `subscription` | `suggestion_kind` | none | `none` | `suggestionKind: { kind: "subscription", label: "Subscription", reasonTemplate: "subscription", answer: "answerSubscription", audience: "reviewer" }` (`audience` new, §16 C4). Its input schema is the payload schema (§5.8). |
| `answerSubscription` | `service` | `finance.read`, `finance.write` | `create` | Called by core on an accept click with `{ suggestionId, option, deviceTimeZone }`; options `track`, `record` (a credit or refund for a tracked row, §9.1) and `mark_urgent`. |
| `trackSubscription` | `action` | `finance.write` | `create` | `action: { actionType: "create_subscription", variants: ["", "update"], undoable: true, permission: "manage", reopensSuggestion: true }` (`reopensSuggestion` new, §16 C9) |
| `editSubscription` | `action` | `finance.write` | `update` | `action: { actionType: "update_subscription", variants: ["", "reminder", "payment_failed"], undoable: true, permission: "manage", reopensSuggestion: true }` |
| `setSubscriptionStatus` | `action` | `finance.write` | `update` | `action: { actionType: "set_subscription_status", variants: ["active", "trial", "cancelled", "expired"], undoable: true, permission: "manage" }` |
| `deleteSubscription` | `action` | `finance.write` | `delete` | `action: { actionType: "delete_subscription", variants: [""], undoable: true, permission: "manage" }` |
| `recordDocument` | `action` | `finance.write` | `create` | `action: { actionType: "record_document", variants: ["invoice", "payment", "credit", "refund"], undoable: true, permission: "manage", reopensSuggestion: true }`; one ledger row on a tracked subscription (§7.2, §9.1) |
| `deleteDocument` | `action` | `finance.write` | `delete` | `action: { actionType: "delete_document", variants: [""], undoable: true, permission: "manage" }`; the row is snapshotted in `inverse` and re-inserted with the same id on undo |
| `resolveRefs` | `resolve_refs` | `finance.read` | `read` | `refs: { kinds: ["finance:subscription"] }`, `resolveRefsSchemas` |
| `search` | `search` | `finance.read` | `read` | `search: { section: "subscriptions" }` |
| `listSubscriptions` | `assistant_tool`, `mcp_tool` | `finance.read` | `read` | Tool name `list_subscriptions` |
| `remindRenewals` | `cron` | `finance.read`, `finance.write` | `update` | `cron: { task: "remindRenewals" }`, `timeoutMs: 30000` |
| `subscriptionDetected` | `webhook_event` | none | `none` | `event: { value: "finance.subscription.detected" }` |
| `renewalDue` | `webhook_event` | none | `none` | `event: { value: "finance.subscription.renewal_due" }` |

All action handlers implement the existing `actionSchemas` contract (`src/lib/modules/shared-schemas.ts:71-91`): `op: "execute" | "undo" | "authorize_undo"`, idempotent by `actionId`, returning `{ result, inverse }` or `refused`. `promptFragment`: "Money Watch tracks the user's subscriptions and their invoices, payments, credits and refunds. Use list_subscriptions for questions about renewals, trials, recurring spend and what was paid in the last 12 months; amounts are in the currency shown and are never converted."

Tool and service shapes:

```ts
// list_subscriptions (assistant_tool + mcp_tool)
input:  { status?: "active" | "trial" | "cancelled" | "expired" | "all"; dueWithinDays?: number /* 1..366 */; limit?: number /* 1..50, default 20 */ }
output: { subscriptions: { ref: RecordRef; vendor: string; plan: string | null; amount: { minor: number; currency: string } | null;
                           cycle: Cycle | null; status: Status; nextRenewalOn: string | null; trialEndsOn: string | null; urgent: boolean }[];
          totals: { currency: string; monthlyMinor: number; yearlyMinor: number; paidLast12MonthsMinor: number }[] } // §12.2; may be negative

// answerSubscription (service; suggestionKind.answer)
input:  { suggestionId: string; option: "track" | "record" | "mark_urgent"; deviceTimeZone: string | null }
output: { result: { status: "accepted"; actionId: string; subscription: RecordRef } | null; refused?: { status: 400 | 403 | 404 | 409; error: string } }
```

## 5. Detection and extraction

### 5.1 Where it runs

```text
delivery → scheduleAgentWork (schedule.ts) → triageMessageGate  ── automatic mail now passes when an enabled step opts in (C6)
        → agent_jobs(triage) → processAgentTriageJob (process.ts)
        → activeModelExtensions ── extensions of steps whose module and per-mailbox switch are on for the reviewer (C15)
        → wantsModel hints      ── invokeCapability("finance", "wantsModel", stepInput with model: null) (C16)
        → modelStep            ── runs when needsModel or a hint asks; schema, prompt and token cap extended (C15);
                                  a refused or failed model no longer stops module steps (C7)
        → runModuleTriageSteps → invokeCapability("finance", "detect", stepInput, { trigger: "auto_read", viewer: reviewer, mailboxIds: [mailbox] })
        → validateStepOutput (≤ 3 suggestions, payload checked against the `subscription` descriptor)
        → planSuggestions      ── muted senders already drop module suggestions
        → storeTriageSuggestions ── module kinds stored (C1), titled by the step (C3)
        → settleTriageSuggestions ── existing realtime `agent_suggestion` ping
```

Detection therefore inherits every existing rule: autonomy `off` means no detection, the kill switch, pause and daily limit apply, the reviewer is the viewer, and per-user module state is checked for the reviewer (`isModuleEnabled`). The model request the hint can add inherits the rest: the external opt-in re-checked on every request, the rate limit, and the mailbox and install spend caps with reservation and settlement in `ai_usage` (§5.7.5). Manual add (§9.4) works whatever the autonomy and never calls the model.

The step skips itself, returning `{ suggestions: [], skipped }`, when:

| Condition | `skipped` | Source |
| --- | --- | --- |
| `facts.phishing` is not empty | none (silent) | A phishing-flagged "invoice" must never become a card. |
| `facts.spam` is true **(new input)** | none | The message is in Spam. |
| No candidate (score below threshold, §5.3) | none | The common case, costs only regex over 8 KB. |
| `finance_subscriptions` missing (migration 0063 not applied) | `migration_pending` | Detected with the same missing-table check `src/lib/modules/state.ts` uses. |

### 5.2 Step input

The existing input (`triageStepSchemas`, `src/lib/modules/shared-schemas.ts:38-68`) carries no headers or body. §16 C5 widens it generically; zod strips unknown keys, so Calendar's step is unaffected:

```ts
input: {
	message: { id, mailboxId, from, fromName /* new */, subject, receivedAt, textExcerpt /* new: ≤ 8 KB of bodyText, nullable */ },
	facts: { authPassed, bulk, knownContact, phishing, automatic /* new */, noReply /* new */, list /* new */, spam /* new */ },
	headers: { listUnsubscribe: string | null, listUnsubscribePost: string | null, listId: string | null }, // new
	attachments: [{ id, contentType, filename, size }],
	model: (TriageResult & { modules?: { finance?: unknown } /* new, C15: only the step's own key, unvalidated JSON */ }) | null,
}
```

`model` is null when the model did not run, was refused or failed (C7). When it ran only because of a hint (§5.7.2), core still passes the result to the step, but plans its own kinds as if it had not run. `model.modules.finance` is whatever the model returned under that key after core's size check; the step treats it as untrusted input (§5.7.3).

`textExcerpt` is the `bodyText` that `src/lib/agent/auto-read/triage-context.ts:57` already computes (`textBody` or readable text from `htmlBody`), cut at 8,192 characters. The headers come from the `readRawHeaders` map already loaded there (lower-case keys, first value). Nothing new is read from R2.

### 5.3 Deterministic detector

`detectSubscription(input, now)` in `src/lib/finance/detect-utils.ts` **(new)** is pure and fully unit-tested. All patterns are linear-time (no nested quantifiers) and run on at most the subject (≤ 300 characters) and the 8 KB excerpt.

Signals, each with a code that ends up in `payload.signals`:

| Code | Signal | Weight |
| --- | --- | --- |
| `subject_keyword` | Subject matches receipt, invoice, payment received/confirmation, billing, renewal, renews, subscription, membership, plan, trial, or any document-type phrase of §5.10 such as refund or credit note (English, Dutch, German, French and Spanish lists in `src/lib/finance/keywords-utils.ts` **(new)**) | 2 |
| `billing_sender` | Sender local part is billing, invoice(s), receipt(s), payments, accounts, or no-reply with a subject keyword | 1 |
| `amount` | A currency amount in the subject or excerpt (§5.4) | required |
| `cycle` | `/month`, `per month`, `monthly`, `/mo`, `per year`, `annual(ly)`, `yearly`, `/yr`, `weekly`, `quarterly`, `every 3 months` and equivalents | 3 |
| `renewal_date` | "renews on", "next billing date", "next payment", "will renew", "auto-renews", "your next charge" followed by a date (§5.5) | 3 |
| `trial` | "trial ends", "free trial ... until", "trial expires" followed by a date | 3 |
| `recurring` | A tracked subscription with the same vendor key, or one of the last 5 messages from the same sender in this mailbox (within 400 days) carried the same amount and currency (§5.6) | 3 |
| `invoice_attachment` | A PDF or image attachment whose filename contains invoice, receipt, factuur, rechnung, facture or recibo, or a credit or refund word (credit, creditnota, gutschrift, avoir, abono, refund) | 1 |
| `model_receipt` | `model.category === "receipt"` (only when the model ran) | 1 |
| `model_fields` | The validated model extension filled at least one field (§5.7.4) | 0 (recorded only) |
| `payment_failed` | "payment failed", "declined", "unable to process your payment", "update your payment method", "past due", "payment unsuccessful" | marks the event (§5.8) and the document type `failed_payment` (§5.10) |
| `doc_invoice`, `doc_payment`, `doc_credit`, `doc_refund` | The document type the classifier chose (§5.10); at most one, recorded only | 0 |

A candidate needs an `amount` **and** at least one of `cycle`, `renewal_date`, `trial` or `recurring`, **and** a total weight of at least 4. One-off receipts (an amount with no recurrence evidence) produce nothing: one-off purchases and general expense tracking are out of scope (§1), and filing them is the reserved `receipt` kind's job, not Money Watch's. Payment-failed mail needs no amount when it matches a tracked subscription by vendor key. Credits, refunds and failed payments produce a card only for a tracked vendor (§5.6): a refund or failed payment from a vendor the user does not track records nothing and never offers "Track it?".

With a validated model extension (§5.7) the rule is applied after the merge (§5.7.4, rule 6): fields the model filled can complete the amount and recurrence conditions, and a model-assisted candidate needs the deterministic receipt condition that triggers the hint (§5.7.2) instead of the weight of 4. The model alone never makes a candidate, so a personal message the model calls a receipt produces nothing unless the detector also saw billing evidence.

Extraction:

- **Vendor.** The sender display name with noise removed ("Billing", "Team", "Payments", "via", "no-reply", quotes), trimmed to 80 characters, control and bidirectional characters removed; else the capitalised first label of the sender's registrable domain.
- **Vendor key.** The sender's registrable domain, lower-case (last two labels, or three when the second-level label is in a short public-suffix list such as `co.uk`, `com.au`, `co.jp`). For payment processors and app stores in `PROCESSOR_DOMAINS` **(new)** (`stripe.com`, `paddle.com`, `paypal.com`, `apple.com`, `google.com`, `fastspring.com`, `chargebee.com`), the key is `<domain>:<slug of the vendor name>`, so two App Store subscriptions stay apart.
- **Plan.** The text after "plan:", "subscription:" or between the vendor name and the amount on the same line, ≤ 80 characters; null when unsure.
- **Cycle.** From the cycle phrase; else from the interval between recurring matches (25-35 days monthly, 85-95 quarterly, 355-375 yearly, 6-8 weekly); else null.
- **Next renewal.** The renewal date; else, when the cycle is known, the message date plus one cycle with `renewalEstimated: true`; else null.
- **Document.** The document type, document date, covered period and document attachment (§5.10).

### 5.4 Amounts and currencies

`amount-utils.ts` **(new)**: `parseAmount(text)` finds `<symbol|code> <number>` and `<number> <symbol|code>`. Decimal separators: the last `.` or `,` followed by exactly the currency's minor digits is the decimal mark, the other is a group separator (`1.299,00 €`, `$1,299.00`, `¥1,500`). Amounts are stored as integer minor units.

- Codes: ISO 4217 codes in `CURRENCY_CODES` **(new)**; minor digits 2 by default, 0 for `JPY KRW ISK CLP VND XOF XAF` and the other zero-decimal codes (fixed table), 3 for `BHD KWD OMR JOD TND`.
- Symbols: `€` EUR, `£` GBP, `¥` JPY, `₹` INR, `CHF`, `kr` only with a code nearby. `$` is USD unless `CA$`, `A$`, `NZ$`, `HK$`, `S$`, `MX$`, `R$` or a code appears in the same line. The user can always correct the currency (§23, question 20).
- Bounds: `0 < amount ≤ 100,000,000` minor units (1,000,000.00), else rejected. When several amounts appear, prefer the one on the same line as a cycle or "total" phrase, then the largest under 10,000.00.

### 5.5 Dates

Formats: ISO `2026-11-01`, `1 Nov 2026`, `Nov 1, 2026`, `November 1st`, `01/11/2026` and `11/01/2026`. Numeric dates with both parts ≤ 12 are read day-first unless the currency is USD or the sender's domain ends in `.us`, and are dropped when still ambiguous and more than 31 days from the message date. A date with no year takes the next occurrence after the message date. Every date is validated in code: it must lie between 31 days before the message date and **2 years** after it; anything else is dropped. Dates are calendar dates (`YYYY-MM-DD`), stored as 00:00 UTC of that date (§7).

### 5.6 Matching and the recurring signal

1. **Tracked subscription.** The step reads `finance_subscriptions` for the reviewer (`user_id = ctx.viewer.userId`) with the same `vendor_key`, preferring the same currency, then the same plan, then the closest amount. A match turns the suggestion into an update (`event: "renewal" | "price_change" | "payment_failed" | "trial" | "refund"`, `subscriptionId` set). The event follows the merged document type (§5.10): `failed_payment` gives `payment_failed`, `credit` or `refund` gives `refund`, and only `invoice`, `payment` or no document type can give `renewal`, `price_change` or `trial`. An amount in the same currency that differs from the row is a `price_change` with `previousAmountMinor` only for those three; a credit or refund amount never counts as a price change.
2. **No tracked match.** The event is `new` or `trial`. When the document type is `credit`, `refund` or `failed_payment`, the step returns no suggestion (§5.3).
3. **Untracked history.** Only when the message has an amount but no cycle, renewal or trial phrase, the step asks the host for at most 5 earlier messages from the same sender in the same mailbox within 400 days (`moduleHost.mail.recentFromSender`, **new**, §16 C10) with their excerpts, and runs `parseAmount` on each. The same amount and currency at a plausible interval gives `recurring` and infers the cycle.

Nothing about untracked vendors is stored by the module: the only persistent trace of a detection is the suggestion itself, which core expires after 14 days.

### 5.7 The model extension (in v1)

Decided for v1 (§23): the roadmap's validated `subscription` object comes from the existing tool-less triage call, through a **generic, descriptor-declared model extension** that any `triage_step` can use. Core gains no Money Watch code: it merges declared JSON data into the request and hands back untrusted JSON. Money Watch never calls a model itself, and no new model request type, prompt store or provider path is added. `model.category === "receipt"` stays a weak corroborating signal (§5.3).

Three facts at `b8afdb8` shape the design: `needsModel` is false for automatic, bulk and no-reply mail (`facts-utils.ts:174-178`), which is nearly all billing mail; the output budget is 400 tokens (`TRIAGE_MAX_OUTPUT_TOKENS`, `src/lib/agent/auto-read/model-call-utils.ts:9`); and the result is closed twice, by the loose provider schema `TRIAGE_JSON_SCHEMA` (`src/lib/agent/auto-read/triage-model.ts:17`) and by `triageResultSchema` (`triage-utils.ts:30`), which strips unknown keys.

#### 5.7.1 The declaration

The `detect` descriptor declares, as JSON data generated in `src/lib/modules/finance/schemas.ts` (the fragment is produced from the zod schema by the same conversion `describeCapability` uses):

```ts
triage: {
	order: 20, automatic: true, capability: "subscriptions",
	model: { // (new) §16 C15
		jsonSchema: {                     // merged by core under properties.modules.properties.finance
			type: "object", additionalProperties: false,
			properties: {
				vendor: { type: ["string", "null"], maxLength: 80 },
				plan: { type: ["string", "null"], maxLength: 80 },
				amount: { type: ["string", "null"], pattern: "^[0-9]{1,9}([.][0-9]{1,3})?$" }, // decimal string, "17.99"
				currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
				cycle: { type: ["string", "null"], enum: ["weekly", "monthly", "quarterly", "yearly", null] },
				nextRenewalOn: { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
				trialEndsOn: { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
				docType: { type: ["string", "null"], enum: ["invoice", "payment", "credit", "refund", "failed_payment", null] }, // §5.10
			},
		},
		instructions: "\"modules\": {\"finance\": only for a receipt, invoice, refund, credit note, renewal or trial notice of a recurring subscription, else omit it: {\"vendor\": merchant as printed, \"plan\": plan name or null, \"amount\": amount charged, refunded or credited as a decimal string such as \"17.99\" or null, \"currency\": ISO 4217 code or null, \"cycle\": \"weekly\" | \"monthly\" | \"quarterly\" | \"yearly\" | null, \"nextRenewalOn\": \"YYYY-MM-DD\" or null, \"trialEndsOn\": \"YYYY-MM-DD\" or null, \"docType\": \"invoice\" (bill) | \"payment\" (paid receipt) | \"credit\" | \"refund\" | \"failed_payment\" | null}}",
		maxOutputTokens: 200,             // the per-extension allowance, 1..200
		wantsModel: "wantsModel",         // a service capability of the same module (§5.7.2)
	},
}
```

Registry rules (`tests/module-registry.test.mjs`): `jsonSchema` is an object schema with `additionalProperties: false`, at most 2 KB serialised, only scalar, nullable and enum property types, no `$ref`, `default` or nested objects; `instructions` is at most 600 characters of printable text with no newline, no `<<<` and no nonce-like `nonce=` fragment; `maxOutputTokens` is an integer from 1 to 200; `wantsModel`, when present, names a `service` capability of the same module. The model is asked for a decimal amount string, not minor units, because code converts it with the currency's minor digits (§5.7.3). The `instructions` string above is 569 characters, so adding a field later needs shorter wording elsewhere.

#### 5.7.2 The `wantsModel` hint

Before `modelStep`, core collects the **active extensions**: those of `triage_step` capabilities whose module is enabled for the reviewer (`isModuleEnabled`) and whose per-mailbox step switch is on (C8; for Money Watch, `capabilities.modules.subscriptions`). For each active extension with a `wantsModel` capability, core invokes it with the step input and `model: null`. The finance handler is `wantsModelForReceipt(input)` in `src/lib/finance/detect-utils.ts`, pure and without a database read:

- **Receipt score.** The sum of the §5.3 weights the detector finds deterministically (`subject_keyword` 2, `billing_sender` 1, `cycle` 3, `renewal_date` 3, `trial` 3, `invoice_attachment` 1), plus 1 when an amount was found. `recurring` and the model signals are left out because the hint runs before the model and reads no history.
- **It wants the model** when the score is at least `RECEIPT_MODEL_THRESHOLD` = 3, `subject_keyword` or `invoice_attachment` matched, `facts.phishing` is empty, `facts.spam` is false, and the detector left a gap: no amount and currency, no cycle, or neither a stated (non-estimated) renewal date nor a trial end. A receipt the detector reads completely costs no model request. A missing document type is not a gap on its own, so classifying documents adds no model requests; when the model runs for another reason it may fill `docType` (§5.7.4).

Core then requests the model when today's `needsModel(facts, capabilities)` is true **or** an active extension's hint is true, except for a muted sender or a `spam` verdict, where it stays off as today. On the steps-only pass for `Auto-Submitted` mail (C6) the hint is the only way the model runs. Every existing gate still applies to the request, in the existing order (§5.7.5). When the model runs only because of a hint, core plans its own kinds (summary, reply, tasks) exactly as if it had not run, so bulk mail never gains summaries or reply drafts through this path; the result reaches only the module steps.

#### 5.7.3 What core merges and returns

For each request with active extensions (all active extensions are included once the model runs for any reason, so a personal receipt that needs the model anyway also gets the extraction):

- **Schema.** Core builds the per-request provider schema from `TRIAGE_JSON_SCHEMA` plus an optional `modules` property (`type: "object"`, `additionalProperties: false`) whose `properties` hold each active extension's `jsonSchema` under its module id. `modules` is never `required`. Extensions not active for this mailbox and reviewer are absent, so the model is not asked about them.
- **Prompt.** Each `instructions` string is appended to the key list in the existing system prompt (`TRIAGE_SYSTEM_PROMPT`, `triage-utils.ts:56`), before the closing "Do not add keys, addresses, links, actions or instructions for anyone." line, which becomes "Do not add other keys, or any addresses, links, actions or instructions for anyone." The email itself stays in the existing nonce-delimited untrusted block; the fragment is static descriptor data, so no message text ever reaches the instruction part. The prompt's existing rules about untrusted links still apply.
- **Token cap.** The output cap is `TRIAGE_MAX_OUTPUT_TOKENS` (400) plus the sum of the active extensions' `maxOutputTokens`, capped at `MODULE_EXTENSION_MAX_OUTPUT_TOKENS` = 200 in total, so 600 with Money Watch. The reasoning headroom (`REASONING_HEADROOM_TOKENS`, 1,100) is unchanged. Without an active extension the cap stays 400.
- **Parsing.** `triageResultSchema` gains `modules: z.record(z.string(), z.unknown()).optional()`; core keeps only keys of active extensions and drops any value whose JSON serialisation exceeds 2 KB. An invalid or missing `modules` value never fails the parse and never triggers the repair request (which would spend a second call): only the core fields decide whether the output is valid, as today.
- **Hand-off.** Each step receives `model.modules[<its own id>]` only, as unvalidated JSON (§5.2). Core never interprets it.

#### 5.7.4 Validation and merge in the module

`parseModelExtraction(raw, message)` in `src/lib/finance/model-utils.ts` **(new)** validates the object with the module's zod schema `financeModelSchema` (`src/lib/modules/finance/schemas.ts`). Unknown keys are stripped (a `cancelUrl`, `link` or any other extra key is dropped without being read). A value that is not an object is treated as absent. Each field is validated on its own and an invalid field is treated as absent; nothing from the model is trusted:

| Field | Rule |
| --- | --- |
| `vendor` | 1-80 characters after removing control, bidirectional and invisible characters and the same noise words as §5.3; never used for the vendor key. |
| `plan` | ≤ 80 characters, same cleaning. |
| `amount` + `currency` | Valid only as a pair. `currency` must be in the ISO 4217 allowlist `CURRENCY_CODES` (§5.4). `amount` must be a decimal string whose fraction has either no digits or exactly the currency's minor digits (`"17.99"` USD, `"1500"` JPY and `"17"` USD are valid; `"17.9"` USD, `"1500.00"` JPY and `"1.2345"` are not). Converted to minor units, it must be positive and at most 100,000,000 (the §5.4 bound). |
| `cycle` | One of `weekly`, `monthly`, `quarterly`, `yearly`; anything else is absent. |
| `nextRenewalOn` | A real calendar date (`YYYY-MM-DD` that round-trips), not before the message date minus 1 day (time zone tolerance) and not after the message date plus 2 years. |
| `trialEndsOn` | Same parsing; not before the message date minus 1 day and not after the message date plus 2 years. |
| `docType` | One of `invoice`, `payment`, `credit`, `refund`, `failed_payment`; anything else is absent. `failed_payment` from the model is treated as absent unless the deterministic payment-failed phrases matched (rule 4), so the model can never mark a row urgent. |

Merge rules, applied by `mergeDetection(deterministic, model)` in the same file, field by field:

1. **A confident deterministic value wins.** Amount and currency, cycle (from a phrase or a recurring interval), a stated renewal date, a stated trial end, a plan matched by "plan:"/"subscription:", a vendor taken from the display name, and a document type classified from the subject, an attachment filename or the payment-failed phrases (§5.10) are confident. The model never overrides them.
2. **The model fills empty fields.** A field the detector left null takes the validated model value. Three weak deterministic values also yield to a validated model value: a vendor that fell back to the domain label, an estimated renewal date (`renewalEstimated: true`), which a validated model date replaces with `renewalEstimated: false`, and a document type classified from the body excerpt only.
3. **Conflicts on amount or currency** keep the deterministic value and record the field in `payload.modelDisagrees` (`["amount"]`, `["currency"]` or both); the suggestion's `reason` becomes `subscription_check_amount` (except for `payment_failed` and `refund`, which keep their own reasons), and the card says "Check the amount before tracking". Conflicts on other confident fields keep the deterministic value silently.
4. **Fixed sources.** The vendor key comes only from the sender address, the cancel link only from the `List-Unsubscribe` header (§5.9), the event only from deterministic matching (§5.6) applied to the merged document type, `payment_failed` and the `failed_payment` document type only from the deterministic phrases, the document attachment, document date and period only from the detector (§5.10), and `unverified` only from `facts.authPassed`. A model `docType` of `credit` or `refund` can therefore turn a tracked vendor's card into a "Record it?" card, which the user still has to accept, but never marks a row urgent or changes its price.
5. **Record what the model did.** `payload.modelFields` lists the fields the model filled; `signals` gains `model_fields` when it is non-empty.
6. **Candidate rule on the merged result.** A candidate needs an amount (from either source) and a cycle, renewal date, trial end (from either source) or the `recurring` signal, and then either the §5.3 deterministic weight of at least 4, or, when any field came from the model, the hint's receipt condition (receipt score at least 3 with `subject_keyword` or `invoice_attachment`). Model-filled fields add no weight. So "Your receipt from Netflix, $17.99" (score 3) becomes a candidate only when the model supplies the cycle or a date, and a message without billing evidence never does.

When the model was not requested, was refused (`external_provider_not_allowed`, `rate_limited`, `spend_cap`), failed (at once for a hint-only request, on the job's last attempt otherwise) or returned nothing valid under `modules.finance`, the step runs on the deterministic result alone with `model: null` or an absent extension (C7), and the outcome is exactly what the detector alone would produce.

#### 5.7.5 Gates, spend and cost

The hint can only add a model request to a job that already passed every existing gate, and the request passes the rest:

- Mailbox autonomy (`off` means no job), the kill switch, pause and the daily job limit are checked when the job starts (`process.ts`), before any hint runs.
- `agent_external_auto_read_allowed` is re-checked on every request, including the repair and parameter fallback (`selectAutoReadModel`, `triage-run.ts`); without it a compatible provider is refused and the step runs with `model: null`.
- The per-mailbox rate limit (`allowAutoReadRequest`) and the mailbox and install spend caps apply unchanged. `withReservedSpend` reserves from `promptChars` and `maxOutputTokens`, so the larger prompt and the raised cap are reserved before the call and settled afterwards in `ai_usage` (`source: "auto_triage"`); without model rates the input tokens count against `UNKNOWN_RATES_INPUT_TOKEN_CAP`.
- Prompts and responses are not persisted, as today.

Cost per affected message: one triage request of at most about 2,500 input tokens (the 8,000-character body plus about 150 tokens of extension instructions) and at most 600 output tokens (typically about 80 for the extension). Only receipt-like mail the detector could not complete adds a request that would not happen today (bulk, list, no-reply and `Auto-Submitted` billing mail); a personal receipt that already needs the model pays only the extra prompt and output tokens. The caps are unchanged (install default $2 per day), so the extension cannot raise spend past them; the cap stops new calls but is not a guaranteed billing ceiling.

### 5.8 Suggestion payload and text

The `subscription` descriptor's input schema (validated by `validateStepOutput` and again by core at storage, §16 C1):

```ts
{
	event: "new" | "renewal" | "price_change" | "trial" | "payment_failed" | "refund", // refund: a credit or refund for a tracked row
	subscriptionId: string | null,          // set when it matches a tracked row; required for payment_failed and refund
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
	document: {                             // §5.10; null when no document type was classified (a notice, not a money document)
		docType: "invoice" | "payment" | "credit" | "refund" | "failed_payment",
		documentOn: string,                 // YYYY-MM-DD; the stated document date, else the message date
		periodStartOn: string | null,       // YYYY-MM-DD; both or neither
		periodEndOn: string | null,
		attachmentId: string | null,        // an attachment of this message; a reference, never content
	} | null,                               // the amount is amountMinor/currency above, always positive
	unverified: boolean,                    // !facts.authPassed
	signals: string[],                      // ≤ 8 codes from §5.3
	modelFields: ("vendor" | "plan" | "amount" | "currency" | "cycle" | "nextRenewalOn" | "trialEndsOn" | "docType")[], // §5.7.4, filled by the model
	modelDisagrees: ("amount" | "currency")[], // §5.7.4, rule 3
}
```

The reader card marks model-filled values with "read by the assistant" in the field's tooltip and shows "Check the amount before tracking" when `modelDisagrees` is not empty, so the user knows which values to check before clicking Track.

Title, built in code by `suggestionTitle` in `src/lib/finance/text-utils.ts` **(new)** and passed as the step's `title` (§16 C3), ≤ 120 characters:

| Event | Title |
| --- | --- |
| `new` | "Netflix $17.99/month, renews 1 Nov. Track it?" (omits unknown parts: "Netflix $17.99/month. Track it?") |
| `trial` | "Netflix trial ends 1 Nov. Track it?" |
| `renewal` | "Netflix renewed, next on 1 Dec. Update it?" |
| `price_change` | "Netflix now $19.99/month, up from $17.99. Update it?" |
| `payment_failed` | "Netflix payment failed. Mark it urgent?" |
| `refund` | "Netflix refunded $17.99. Record it?" (`refund`) or "Netflix credit note for $5.00. Record it?" (`credit`) |

For `new`, `renewal` and `price_change` with a document, the card adds one line naming what Track also records ("Records this invoice of $17.99, 1 Nov", with "Attachment: invoice-2026-11.pdf" when `attachmentId` is set). Amounts are formatted with `Intl.NumberFormat` in the reviewer's locale. `reason` is the matching `reasonTexts` code (`subscription`, `subscription_price_change`, `subscription_payment_failed`, `subscription_trial`, `subscription_refund`, or `subscription_check_amount` when the model disagreed on the amount or currency, §5.7.4). The card shows an "Unverified sender" warning when `unverified` is true, like Calendar invites.

### 5.9 The cancel link

`parseCancelLink(listUnsubscribe, listUnsubscribePost)` in `src/lib/finance/cancel-link-utils.ts` **(new)**:

- Parse the comma-separated `<...>` entries of `List-Unsubscribe` (RFC 2369), at most 2,048 characters each.
- Keep the first `https:` URL with a hostname that is not an IP literal, `localhost` or a `.local`/`.internal` name, and has no credentials. `http:` is dropped. `mailto:` is dropped in v1 (§23, question 10).
- `oneClick` is true only when `List-Unsubscribe-Post` is exactly `List-Unsubscribe=One-Click` (RFC 8058). It is informational: v1 never sends the POST (§23, question 11).
- The body, attachments and model output are never searched for links. A message without the header has `cancelLink: null` and the view says "No cancel link in this sender's mail".

### 5.10 Document type, date, period and attachment

`classifyDocument(input, detection)` in `src/lib/finance/document-utils.ts` **(new)** is pure and unit-tested, and fills `payload.document` (§5.8) for the ledger (§7.2). It runs on the same bounded subject, excerpt and attachment list as §5.3.

**Document types.** The enum is closed: a bill that asks for payment is an `invoice`; a receipt or confirmation that a payment was taken is a `payment`; a credit note or account credit is a `credit`; money returned is a `refund`; a declined or failed charge is a `failed_payment`. An invoice marked as paid ("Invoice #123 paid", "Amount paid") is a `payment`, because it confirms the money moved.

| Type | Phrases (English; Dutch, German, French and Spanish equivalents in `keywords-utils.ts`) |
| --- | --- |
| `failed_payment` | The §5.3 `payment_failed` phrases |
| `refund` | "refund", "refunded", "has been refunded", "refund issued" (terugbetaling, terugbetaald; Rückerstattung, erstattet; remboursement, remboursé; reembolso, reembolsado) |
| `credit` | "credit note", "credit memo", "account credit", "credited to your account" (creditnota, creditfactuur; Gutschrift; avoir, note de crédit; nota de crédito, abono) |
| `payment` | "receipt", "payment received", "payment confirmation", "thank you for your payment", "amount paid", "you've been charged", "we charged" (betalingsbewijs, betaling ontvangen; Zahlungsbestätigung, Quittung, Zahlung erhalten; reçu, paiement reçu, confirmation de paiement; recibo, pago recibido, confirmación de pago) |
| `invoice` | "invoice", "amount due", "balance due", "payment due", "your bill" (factuur, te betalen; Rechnung, fälliger Betrag; facture, montant dû; factura, importe a pagar) |

Rules, in order:

1. The deterministic payment-failed phrases always give `failed_payment` (confident).
2. Otherwise the subject is classified first, then attachment filenames (`invoice`/`factuur`/`rechnung`/`facture`/`factura` give `invoice`, `receipt`/`recibo` give `payment`, the credit and refund words give `credit` or `refund`); a match in either is confident (§5.7.4, rule 1). Only when both are silent is the excerpt classified, and a body-only match is weak.
3. Within one source, precedence is `refund` > `credit` > `payment` > `invoice`, because refunds and credit notes quote the original payment and receipts quote the invoice.
4. No match leaves `document: null`: the message is a notice (a trial ending, a "renews soon" reminder), not a money document, so nothing is recorded in the ledger. The user can still record it by hand (§9.4).
5. `invoice`, `payment`, `credit` and `refund` need an amount and currency, else `document` is null; `failed_payment` may have none.

**Document date.** A date after "invoice date", "date paid", "payment date", "receipt date", "date of issue", "refund date" or "credit note date" (and equivalents), parsed as in §5.5; it must lie between the message date minus 400 days and the message date plus 1 day. Otherwise, the message date in the reviewer's time zone.

**Period covered.** A date range after "billing period", "service period", "period", "for the period" or "from", written as two §5.5 dates joined by "-", "–", "to" or "through" ("1 Oct 2026 – 31 Oct 2026", "Oct 1 - Oct 31, 2026"). Valid only when start ≤ end, the range is at most 366 days and both dates lie between the message date minus 400 days and plus 2 years; otherwise both are null. The period is never inferred from the cycle.

**Document attachment.** The first PDF, then the first image, whose filename matched `invoice_attachment` (§5.3); otherwise the message's only PDF attachment when it has exactly one; otherwise null. Only the attachment id is kept. The bytes are read only through `moduleHost.mail.readAttachment` (PDF text, §6), and the user opens the file through the existing attachment route (§12.2), so every read goes through `getAttachmentForUser`. The model never names the attachment.

## 6. Attachments

| Attachment | v1 behaviour |
| --- | --- |
| PDF invoice or receipt | Best-effort text extraction (below), only when the body yielded no amount and the filename or subject matched a keyword. Referenced by id as the ledger row's document attachment (§5.10). |
| Image receipt (`image/*`) | Signal only (`invoice_attachment`); no OCR. Referenced as the document attachment when no PDF qualifies (§5.10). |
| Anything else | Ignored. |

PDF extraction, `src/lib/finance/pdf-text-utils.ts` **(new)**, pure apart from `DecompressionStream`, which both runtimes have:

1. Attachments are read only through `moduleHost.mail.readAttachment(ctx, messageId, attachmentId, { maxBytes: 2_097_152 })` (`src/lib/email/module-read.ts:47`). It already checks access through `getAttachmentForUser` and returns `base64` for PDFs; the module never touches R2.
2. Skip encrypted files (`/Encrypt`) and files that were `truncated`.
3. Walk at most 32 `stream ... endstream` objects; inflate `/FlateDecode` streams with `DecompressionStream("deflate")`, capping output at 1 MiB per stream and 4 MiB in total (decompression bombs stop at the cap).
4. Collect text from `Tj`, `TJ`, `'` and `"` operators (literal and hex strings, standard escapes), up to 64 KB, then run the same detector on it. CID fonts and object streams yield little or nothing, which is acceptable.
5. The whole attachment path is bounded by the step's 15-second `timeoutMs`; a timeout is retryable and retries the job, so the extractor also stops itself after 5 seconds and returns what it has.

Money Watch never copies, moves or deletes an attachment: the ledger stores only its id, and attachment storage (including the parallel [storing attachments once](attachments-once.md) change) stays behind `moduleHost.mail.readAttachment` and `getAttachmentForUser`, so it does not affect this module.

Extracted text is never stored, never logged and never sent to the model: the triage request carries only the message body it carries today, and the PDF runs inside the step, after the model call. §23, question 6 asks whether this ships in v1 or waits.

## 7. Data model and migration 0063

Schema in `src/db/schema/finance.ts` **(new)**, merged into the Drizzle `schema` in `src/db/index.ts` and added to the schema list in `drizzle.config.ts`. Not in `src/db/schema/index.ts`, which is at its `max-lines` baseline.

### 7.1 `finance_subscriptions`

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
| `payment_failed_at` | integer (timestamp) | Non-null means urgent; cleared by the next accepted `payment` document or by the user. |
| `reminder_days` | integer NOT NULL default 3 | 0 turns reminders off; 0-30. |
| `calendar_reminder` | integer bool NOT NULL default true | Per item; only acts when Calendar is on for the owner. |
| `last_reminded_for` | integer (timestamp) | The due date the last reminder covered; the cron's idempotency key. |
| `calendar_event_id` | text → `calendar_events.id` ON DELETE set null | The reminder event, if any. |
| `cancel_url` | text | From `List-Unsubscribe` only (§5.9). |
| `cancel_one_click` | integer bool NOT NULL default false | |
| `previous_amount_minor` | integer | Set on a price change. |
| `price_changed_at` | integer (timestamp) | The view flags a change for 90 days. |
| `source_message_id` | text → `messages.id` ON DELETE set null | The message it was first found in. |
| `last_message_id` | text → `messages.id` ON DELETE set null | The latest message applied to the row's fields (invoice, payment or notice; credits and refunds do not change it). |
| `created_at`, `updated_at` | integer (timestamp) NOT NULL | |

Indexes: `finance_subscriptions_user_vendor_idx (user_id, vendor_key)` (non-unique: two plans from one vendor are allowed), `finance_subscriptions_due_idx (status, next_renewal_at)` and `finance_subscriptions_trial_idx (status, trial_ends_at)` for the cron, `finance_subscriptions_mailbox_idx (mailbox_id)`.

Status transitions are free (the user may set any status); detection only proposes `trial → active` (an invoice or payment after a trial) and `payment_failed_at`. Nothing moves a row to `expired` automatically in v1.

### 7.2 `finance_charges`: the document ledger

One row per money document linked to one tracked subscription: an invoice, a payment receipt, a credit note, a refund or a failed payment. It gives the vendor history, the 12-month paid total (§12.2) and, after Drive ships, the list of files to file (§24). The vendor is the subscription's; the ledger has no vendor column. The table keeps the approved name `finance_charges` (§23, question 4): renaming it to `finance_documents` would be more exact, but the name is internal, already in the backup lists and decisions, and never shown to users, who see "documents".

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Derived from the recording action's `actionId`, like `finance_subscriptions.id`, so a resumed pending action does not insert twice. |
| `subscription_id` | text NOT NULL → `finance_subscriptions.id` ON DELETE cascade | |
| `user_id` | text NOT NULL → `users.id` ON DELETE cascade | Denormalised for owner checks. |
| `message_id` | text → `messages.id` ON DELETE set null | The source message. The ledger keeps the amount after trash retention purges the mail. |
| `attachment_id` | text, no foreign key | The id of the message attachment that is the document (§5.10), or null. A reference, never a copy: the bytes are read only through `moduleHost.mail.readAttachment(ctx, message_id, attachment_id, …)`, which checks that both still exist and that the viewer may read them. It is ignored once `message_id` is null. There is deliberately no foreign key to `message_attachments`: every read already goes through the message, and it keeps the ledger independent of how attachments are stored ([storing attachments once](attachments-once.md)). |
| `doc_type` | text enum `invoice, payment, credit, refund, failed_payment` NOT NULL | §5.10. Sign comes from the type, never from the amount. |
| `amount_minor` | integer | Always positive (1..100,000,000). Credits and refunds reduce totals because of their type (§12.2). Required for every type except `failed_payment` (checked in code). |
| `currency` | text | ISO 4217; non-null when `amount_minor` is set (checked in code). |
| `document_at` | integer (timestamp) NOT NULL | 00:00 UTC of the document date: the stated date, else the message date (§5.10). |
| `period_start_at`, `period_end_at` | integer (timestamp) | 00:00 UTC of the stated period covered; both or neither; never inferred. |
| `filed_ref` | text | Reserved for Drive filing (§24): the Drive file reference once filed. Always null in v1, and nothing in this mission reads or writes it; it is added now so the follow-up needs no migration on this table. |
| `created_at` | integer (timestamp) NOT NULL | |

Indexes: unique `finance_charges_dedupe_idx (subscription_id, message_id, doc_type)`, so one message gives at most one document of each type per subscription; `finance_charges_user_idx (user_id, document_at)` for the 12-month total. SQLite treats null values as distinct in a unique index, so rows whose message was purged no longer take part in the check; that is harmless because every new row has a message (§9.4).

Writes: the ledger is written only by accepted or manual actions (§9.1), with `INSERT … ON CONFLICT DO NOTHING` on the dedupe index; an action's `inverse` names only the ledger rows that action inserted, so undo never removes a document recorded earlier by another action. A row is never edited in place: a wrong document is removed (`delete_document`, undoable) and recorded again.

### 7.3 Migration

This mission claims 0063 (journal `idx` 66). `mission/attachments-once` runs in parallel and takes 0064 or later; Money Watch does not depend on it, because attachments are only read through `moduleHost.mail.readAttachment` (§6). Whichever of the two merges second rebases onto the other: it renumbers its migration file and journal entry to the next free number and `idx` if needed, and updates the "last migration" assertions in `tests/module-migration.test.mjs` (and `copyMigrationsBefore` arguments such as the one in §20.1) so `tests/migration-order.test.mjs` keeps passing. Drive storage's planned numbers come after both.

`drizzle/migrations/0063_add_finance_module.sql` **(new)**, hand-written in the generated style of 0062 (one statement per line, backticks, `--> statement-breakpoint`), journal entry `{ "idx": 66, "version": "6", "when": 1788851280028, "tag": "0063_add_finance_module", "breakpoints": true }` in `drizzle/migrations/meta/_journal.json`:

```sql
CREATE TABLE `finance_subscriptions` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null, `contact_id` text REFERENCES `contacts`(`id`) ON DELETE set null, `vendor` text NOT NULL, `vendor_key` text NOT NULL, `plan` text, `amount_minor` integer, `currency` text, `cycle` text, `next_renewal_at` integer, `renewal_estimated` integer DEFAULT false NOT NULL, `trial_ends_at` integer, `status` text DEFAULT 'active' NOT NULL, `payment_failed_at` integer, `reminder_days` integer DEFAULT 3 NOT NULL, `calendar_reminder` integer DEFAULT true NOT NULL, `last_reminded_for` integer, `calendar_event_id` text REFERENCES `calendar_events`(`id`) ON DELETE set null, `cancel_url` text, `cancel_one_click` integer DEFAULT false NOT NULL, `previous_amount_minor` integer, `price_changed_at` integer, `source_message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `last_message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `finance_subscriptions_user_vendor_idx` ON `finance_subscriptions` (`user_id`,`vendor_key`);--> statement-breakpoint
CREATE INDEX `finance_subscriptions_due_idx` ON `finance_subscriptions` (`status`,`next_renewal_at`);--> statement-breakpoint
CREATE INDEX `finance_subscriptions_trial_idx` ON `finance_subscriptions` (`status`,`trial_ends_at`);--> statement-breakpoint
CREATE INDEX `finance_subscriptions_mailbox_idx` ON `finance_subscriptions` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `finance_charges` (`id` text PRIMARY KEY NOT NULL, `subscription_id` text NOT NULL REFERENCES `finance_subscriptions`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `attachment_id` text, `doc_type` text NOT NULL, `amount_minor` integer, `currency` text, `document_at` integer NOT NULL, `period_start_at` integer, `period_end_at` integer, `filed_ref` text, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_charges_dedupe_idx` ON `finance_charges` (`subscription_id`,`message_id`,`doc_type`);--> statement-breakpoint
CREATE INDEX `finance_charges_user_idx` ON `finance_charges` (`user_id`,`document_at`);
```

- No `module_settings` row is inserted: a missing row already means `defaultEnabled`, and inserting one would break the four-row assertions in `tests/module-migration.test.mjs:94-96` and `tests/backup-module-tables.test.mjs:128-140`.
- `agent_suggestions.kind` and `agent_actions.action` are TypeScript-only enums with no SQL `CHECK` (migration 0060), so the new kind and action types need no SQL.
- The setup path and the Node runtime pick the file up through the migration bundle; nothing else is hand-maintained.
- **Before 0063 is applied** (deploys never migrate): the page renders an empty state that points to the database update banner; `GET` routes answer `{ subscriptions: [], migrationPending: true }`; writes answer 409 `{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" }`; the step returns `skipped: "migration_pending"`; the cron returns without work; refs resolve as unavailable. Every check reads `sqlite_master`, never a new column.

## 8. Backups

Per AGENTS.md, in the same change as the migration:

| List | Change |
| --- | --- |
| `BACKUP_TABLES` (`src/lib/backups/export.ts:8-53`) | Insert `finance_subscriptions`, then `finance_charges`, directly after `booking_appointments` (after every parent: `users`, `mailboxes`, `contacts`, `messages`, `calendar_events`). |
| `BACKUP_TABLE_GROUPS` (`src/lib/backups/table-groups.ts`) | Both in `mail` ("Mail and related data"), next to `calendar_events` and `email_templates`, which are also per-user data derived from mail. |
| `DatabaseBackupTable` (`src/lib/backups/types.d.ts`) | Add `"finance_subscriptions" \| "finance_charges"`. |
| `REQUIRED_BACKUP_TABLES`, `INTERNAL_TABLES` | Unchanged: older documents omit the tables and `fillMissingBackupTables` fills `[]`; the tables are user data, not derived. Reminder bookkeeping is columns, not a transient table. |
| Ledger columns | Nothing to add: export reads `SELECT *` per table (`src/lib/backups/export.ts:147`) and restore inserts the columns the target table has (`src/lib/backups/restore-utils.ts:49`), so `attachment_id`, `doc_type`, `document_at`, the period columns and `filed_ref` are covered. `attachment_id` has no foreign key, so restore order against `message_attachments` does not matter; it is still after it in `BACKUP_TABLES`. The ledger holds no file content; the referenced attachment rows are backed up with `message_attachments` as today. |

Behaviour to test (§20): a backup taken before 0063 restores after 0063 with both tables empty; a backup after 0063 round-trips with rows, every ledger column (including a null and a set `attachment_id` and `filed_ref` left null) and FK order intact; restoring a document that has Money Watch rows into a database without 0063 fails with the existing "Apply pending database migrations before restoring finance subscriptions." message (`src/lib/backups/export.ts:281` replaces underscores with spaces); `assertBackupTablesCoverDatabase` passes on a migrated database.

## 9. Accepting, editing and undo

### 9.1 Writes go through `agent_actions`

Every write a user makes is an `executeAction` row (`src/lib/agent/auto-read/execute.ts:178`): `pending` first, then the module's `execute` handler, then `applied` or `failed`, with `before`/`inverse` stored for undo inside `DEFAULT_UNDO_WINDOW_MS` (7 days, `src/lib/agent/auto-read/actions-utils.ts:15`). Undo uses the existing `POST /api/agent/actions/[id]/undo`; the module's `undo` handler restores the inverse and is idempotent. The module reaches the executor through `moduleHost.actions.execute` **(new, §16 C10)**, so no Money Watch file lives under `src/lib/agent/auto-read/` (unlike Calendar's grandfathered invite files).

| User decision | Action type and variant | Effect | Inverse (undo) |
| --- | --- | --- | --- |
| Track (new) | `create_subscription` `""` | Insert row and, when the card has an `invoice` or `payment` document, its ledger row; link contact; emit `finance.subscription.detected` | Delete row (ledger rows cascade); remove its calendar reminder; reopen the suggestion. Refused with 409 while the row holds a ledger row this action did not insert, so a later document is never deleted with it |
| Track (matches a row) | `create_subscription` `update` | Update renewal date, amount (price change), cycle, cancel link, `last_message_id`; `trial → active` on an invoice or payment; clear `payment_failed_at` on a payment; insert the `invoice` or `payment` ledger row when the card has one | Restore the previous columns, delete the ledger row it inserted; reopen the suggestion |
| Record (credit or refund card) | `record_document` `credit` or `refund` | Insert the ledger row only; price, cycle, renewal and trial dates, status and `last_message_id` are never changed | Delete the ledger row; reopen the suggestion |
| Mark urgent (payment failed card) | `update_subscription` `payment_failed` | Set `payment_failed_at`; insert a `failed_payment` ledger row | Clear it, delete the ledger row; reopen the suggestion |
| Edit fields | `update_subscription` `""` | Update vendor, plan, amount, currency, cycle, dates | Restore the previous columns |
| Change reminder | `update_subscription` `reminder` | `reminder_days`, `calendar_reminder`; removes the calendar event when turned off | Restore; the cron recreates the event if due |
| Change status | `set_subscription_status` `<status>` | Set status; `cancelled`/`expired` remove the reminder event | Restore the previous status |
| Add by hand or from a message | `create_subscription` `""` with no suggestion | Insert row (and the ledger row when added from a message with a document type set in the dialog); emit `finance.subscription.detected` with `source: "manual"` (§14) | Delete row; refused like Track's while a later ledger row exists |
| Add a document from a message | `record_document` `<doc type>` with no suggestion | Insert one ledger row on a tracked subscription the user picks (§9.4); a `payment` also clears `payment_failed_at`, nothing else changes | Delete the ledger row (and restore `payment_failed_at`) |
| Remove a document | `delete_document` `""` | Delete one ledger row (snapshot in `inverse`) | Re-insert it with the same id |
| Remove | `delete_subscription` `""` | Delete row and its ledger rows (snapshot in `inverse`, ≤ 200 ledger rows) | Re-insert both with the same ids |

Dismissing a card is core's existing `dismiss` and touches no Money Watch data. A "Not a subscription" choice that mutes the vendor is deferred.

### 9.2 Accept flow

1. The user clicks **Track**, **Record it** (credit or refund) or **Mark urgent** on the card; core's `acceptSuggestion` (`src/lib/agent/auto-read/suggestion-api.ts:165`) finds `MODULE_ANSWERERS.subscription`, and `answerSuggestion` (`src/lib/agent/auto-read/module-actions.ts:118`) invokes `answerSubscription` as the user.
2. The service loads the suggestion with `moduleHost.suggestions.get` **(new)**, which returns it only if its kind belongs to `finance`, it is still `open`, and the viewer has full access to its mailbox and is its reviewer (audience, §13).
3. It re-validates the payload, re-runs the match against the owner's rows (the row may have been created since detection, so a second accepted card for the same vendor becomes an `update`), checks that `document.attachmentId`, when set, is still an attachment of the suggestion's message (`moduleHost.mail.getMessage`; otherwise the reference is dropped and the document is still recorded), and calls `moduleHost.actions.execute` with `capability: "trackSubscription"` (`track`), `"recordDocument"` (`record`) or `"editSubscription"` (`mark_urgent`), the suggestion and message ids and `before` (the matched row, if any). A `record` answer whose subscription no longer exists answers 409 and leaves the card open.
4. On success it calls `moduleHost.suggestions.decide(ctx, "finance", id, "accepted")` **(new)**, which sets `decided_at`/`decided_by_user_id` and sends the existing quiet realtime ping; the response carries `actionId` for the undo toast.
5. Idempotency comes from the existing live unique index on `(suggestion_id, action, variant)`: a double click returns the same action. The ledger's dedupe index (§7.2) adds a second guard: a document already recorded for that subscription, message and type (for example by hand) is not inserted again, and the action's `result` says `documentRecorded: false`.

### 9.3 Undo reopens the card

When the undone action's descriptor has `reopensSuggestion: true` **(new)**, core reopens the suggestion after the undo commits if no other live action of the same module remains on it, the same rule as Calendar's `reopenIfIdle` (`src/lib/agent/auto-read/calendar-state.ts:58`) made generic.

### 9.4 Manual add

- **By hand:** the "Add subscription" dialog on `/finance` (vendor, plan, amount, currency, cycle, next renewal, trial end, reminder days, calendar reminder, mailbox for the audit row). `POST /api/finance/subscriptions`.
- **From any message:** the reader's overflow menu shows "Track as subscription" through the new `message-menu` slot (§16 C13). It calls `POST /api/finance/detect { messageId }`, which runs the same detector (§5) through `moduleHost.mail.getMessage` with the new `text` and `headers` options, and opens the dialog prefilled with what it found, including the cancel link from the message's own `List-Unsubscribe` and, when a document type was classified, a "Record this message as" field (document type, amount, currency, document date, period, attachment). Nothing is written until the user saves. It works with automatic reading off.
- **A document from any message:** the second `message-menu` item, "Add to a tracked subscription", calls the same `POST /api/finance/detect` and opens the document dialog: the tracked subscription (the detector's match preselected, any of the user's rows selectable), the document type (`invoice`, `payment`, `credit`, `refund`; a failed payment is recorded only through the card's Mark urgent), amount, currency, document date, optional period, and the attachment (one of the message's attachments or none, listed from `moduleHost.mail.getMessage`). Saving calls `POST /api/finance/subscriptions/[id]/documents`, which records `record_document` with the message as the source; a duplicate of the same subscription, message and type answers 409 `{ code: "DOCUMENT_EXISTS" }`. A document always has a source message, so there is no document entry without one; one-off purchases with no subscription are out of scope (§1).

### 9.5 Which mailbox an audit row names

`agent_actions.mailbox_id` is NOT NULL, Activity is per mailbox and the executor checks `manage` on that mailbox. The audit mailbox is the row's `mailbox_id` when the owner still manages it; otherwise the first mailbox the owner manages (oldest first). With none, writes answer 409 `{ code: "NO_MAILBOX", error: "Money Watch needs a mailbox you manage to record changes" }`. Rows added by hand store the mailbox chosen in the dialog (default: the selected mailbox).

## 10. Renewal, payment and cancel nudges

### 10.1 The cron task

`remindRenewals` runs on the `*/5 * * * *` tick through `runModuleCronTasks` on both runtimes (`worker.ts:244`, `server/runtime/scheduler.ts`), with `viewer: null` and grants `finance.read`, `finance.write`. A daily `0 2 * * *` run would remind people in other time zones at odd hours and, on Node, be missed entirely when the process is down at 02:00.

```text
now = input.scheduledTime ?? Date.now()                       -- C14 passes scheduledTime
due(row) = status = 'trial' AND trial_ends_at ? trial_ends_at : next_renewal_at
SELECT … FROM finance_subscriptions
 WHERE status IN ('active','trial') AND reminder_days > 0
   AND due BETWEEN now - 1 day AND now + 31 days
   AND (last_reminded_for IS NULL OR last_reminded_for <> due)
 ORDER BY due LIMIT 100
for each owner (grouped):
  skip unless moduleHost.modules.isEnabledFor(ctx, owner, "finance")   -- per-user switch; row untouched
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
- Failures log `finance.reminder_failed` with the subscription id and error code only (no vendor, amount or dates), and never stop the loop.

### 10.2 The realtime notice

`moduleHost.notify(ctx, "finance", [owner], { notice: "renewal_due", title, body, href })` **(new, §16 C11)** sends a `module_notice` payload over the existing hub. Text: "Netflix renews in 3 days ($17.99)", "Your Netflix trial ends tomorrow", with `href: "/finance?subscription=<id>"`. The client shows a toast with an "Open" link and dispatches `kite:module-notice`, which refreshes the nav count. Notices are fire-and-forget (lost when no tab is open); the badge and the view read the database, so nothing depends on delivery.

### 10.3 The badge

`GET /api/finance/badge` → `{ count }`: the owner's `active`/`trial` rows whose due date is today or later and within `reminder_days`, plus `active` rows with `payment_failed_at`. The sidebar item's count (§16 C12) fetches it on load, every 5 minutes, on window focus and on `kite:module-notice` or `kite:agent-suggestion` events. Open `subscription` cards also count in For you through the existing For you count.

### 10.4 Cancel before the renewal

Rows with a `cancel_url` show **Cancel before 1 Nov** (the day before the due date). The click opens the link with `window.open(url, "_blank", "noopener,noreferrer")`, the same rule as the reader's unsubscribe button (`openUnsubscribeUrl`, `src/components/message-actions/utils.ts`), after showing the link's host ("Opens netflix.com"). Kite never fetches or POSTs the URL. After the click the row offers "Did you cancel? Mark as cancelled", which is a normal audited `set_subscription_status` write. Without a link, the button reads "Open latest message".

### 10.5 Failed payments

Payment-failed mail for a tracked vendor produces a `subscription` card with `event: "payment_failed"` and reason `subscription_payment_failed` ("Netflix payment failed. Mark it urgent?"); it shares the kind's single `badgePriority` (§3). Accepting sets `payment_failed_at` and records a `failed_payment` ledger row, which never counts toward totals (§12.2); the row then sorts into "Needs attention" and counts in the badge. The roadmap says failed-payment keywords "flip the item to urgent"; under suggest-only that flip needs the click (§23, question 15).

## 11. Calendar reminder service

Calendar has no `service` that another module can call to create an event (its `createEvent` is an action executed by the invite helpers, and tools are not reachable through `moduleHost.invoke` with the right grants). This milestone adds two Calendar services. They are Calendar module changes, not core changes.

| Name | Surfaces | Scopes | Effect | Input | Output |
| --- | --- | --- | --- | --- | --- |
| `upsertReminder` **(new)** | `service` | `calendar.write` | `create` | `{ userId, key, title (≤ 120), description (≤ 2000), date: "YYYY-MM-DD", time: "HH:MM", durationMinutes (5-120), timeZone, sourceMessageId: string \| null }` | `{ eventId, ref: { kind: "calendar:event", id }, created: boolean }` |
| `removeReminder` **(new)** | `service` | `calendar.write` | `delete` | `{ userId, key }` | `{ removed: boolean }` |

- Implementation in `src/lib/calendar/reminders.ts` **(new)**. `userId` must equal `ctx.viewer.userId` (a caller can only write the calendar of the user it acts for), else `forbidden`.
- `key` must match `^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{1,100}$` (no `@`, so it can never equal a real invitation UID). It is stored in `calendar_events.ical_uid`; Money Watch uses `finance-renewal:<subscriptionId>`, one event per subscription that moves with the due date.
- The `calendar_events_ical_uid_idx` index on `(user_id, ical_uid)` is not unique, so the insert is `INSERT … SELECT … WHERE NOT EXISTS` on `(user_id, ical_uid)`, like `insertTriageJob`, followed by an update when it exists.
- Writes go through `emitCalendarWrites` (`src/lib/calendar/webhook-events.ts:23`), so `calendar.event.created`/`updated`/`deleted` webhooks and calendar search behave as for any event.
- Money Watch calls them with `moduleHost.invoke(ctx, "calendar", "upsertReminder", …)` only after `moduleHost.modules.isEnabledFor(ctx, owner, "calendar")`; a `module_disabled` or other failure is logged and never blocks the notice. The event is at 09:00 for 15 minutes in the owner's time zone on the due date, titled "Netflix renews ($17.99)" or "Netflix trial ends", with a description linking to `/finance?subscription=<id>`.
- Undo of `create_subscription`, `delete_subscription`, turning the calendar reminder off and status `cancelled`/`expired` call `removeReminder`. Turning Money Watch or Calendar off leaves existing events in place (data stays).

## 12. The Subscriptions view

### 12.1 Page and guard

`src/app/(finance)/layout.tsx` **(new)** calls `requireModulePage("finance")` above the shell, with `export const dynamic = "force-dynamic"`, the pattern of `src/app/(import)/layout.tsx`, and renders `DashboardSectionShell`. The page is `src/app/(finance)/finance/page.tsx` **(new)**; components live in `src/components/finance/` **(new)** with sibling `*-types.d.ts` and `*-utils.ts` files. The layout is added to the guarded-layout list in `tests/module-route-guard.test.mjs`.

### 12.2 Layout

| Area | Content |
| --- | --- |
| Header | "Subscriptions", an **Add subscription** button, a status filter (Active and trials, Cancelled and expired, All). |
| Totals | Monthly and yearly cost of `active` rows, one line per currency (no conversion): weekly × 52 / 12, monthly, quarterly / 3, yearly / 12; yearly is monthly × 12. Trials are listed as "after trials: +$x/month"; rows without an amount or cycle are counted as "n without a price". Next to them, **Paid in the last 12 months**, one line per currency, from the ledger (below). |
| Needs attention | Payment failed, trials ending within their reminder window, renewal dates that passed without a new invoice. |
| Upcoming renewals | Sorted by due date: vendor, plan, amount and cycle, "renews in 5 days (1 Nov)", status badge, "Increased from $14.99" or "Decreased from …" chip for 90 days after a change, "estimated" marker. |
| No date | Active rows without a renewal date. |
| Cancelled and expired | Collapsed. |
| Row menu | Edit, Reminder (Off, 1, 3, 7, 14 days before; Add to calendar), Mark as cancelled / active / expired, Cancel before … (§10.4), Remove. Every write shows the undo toast. |
| Detail drawer (`?subscription=<id>`) | Fields, the cancel link host, this subscription's paid total for the last 12 months, and the vendor history: its documents from `finance_charges`, newest first, each with type ("Invoice", "Payment", "Credit note", "Refund", "Payment failed"), document date, period when known, amount (credits and refunds shown as "−$5.00"), an "Open thread" link to the source message's conversation through its `mail:message` ref, and **Open document** when `attachment_id` is set, which opens `/api/messages/<messageId>/attachments/<attachmentId>?preview=1`, the existing route that checks access with `getAttachmentForUser`, so a user who lost access to the mailbox gets its 404. A purged message shows "Message deleted" with no links. Each document has a Remove item (`delete_document`, with undo). An invoice paired with a payment (below) is marked "Paid" and does not count again. |

**Paid in the last 12 months.** `paidLast12Months(documents, today)` in `src/lib/finance/totals-utils.ts` is pure and computes, per currency over the owner's ledger rows on every subscription whatever its status (a cancelled subscription was still paid for):

1. A document counts when its `document_at` is on or after the same calendar date 12 months before today, in the owner's time zone, and not after today.
2. `payment` adds its amount. `refund` subtracts its amount. `failed_payment` never counts.
3. `invoice` adds its amount unless it is **paired** with a `payment` of the same subscription; `credit` subtracts its amount unless it is paired with a `refund` of the same subscription. So a period is counted once, preferring the money movement (`payment`, `refund`) over the document asking for or promising it (`invoice`, `credit`), and an invoice that was auto-charged with no separate receipt still counts.
4. **Pairing**, per subscription and currency, before the window is applied: when both documents state a period, they pair if their `period_start_at` is equal; otherwise they pair if their amounts are equal and their document dates are at most 31 days apart. Each payment pairs with at most one invoice (and each refund with at most one credit): candidates are taken nearest date first, ties to the older `id`.
5. The result may be negative (a refund larger than the year's payments) and is shown as is. Documents without an amount are skipped.

The function is unit-tested on the cases in §20.1, and the same function computes the `paidLast12MonthsMinor` totals of `GET /api/finance/subscriptions` and `list_subscriptions`.

The add/edit dialog and the document dialog have more than a few fields, so their `DialogContent` gets `max-h-[calc(100vh-4rem)] overflow-y-auto`. Colours use the `blue-*` palette and semantic tokens so Kite, Classic and dark mode all work; the page is checked in all three (§20).

### 12.3 API routes

Every route below is **(new)**. Every method is wrapped in `withModule("finance", …)` and calls `requireSessionUser` then `checkUser`. A row is visible only to its owner; anyone else gets 404. Run `npm run docs:generate` after adding the routes.

| Route | Purpose |
| --- | --- |
| `GET /api/finance/subscriptions?status=` | `{ subscriptions, totals, migrationPending? }`; each total carries `paidLast12MonthsMinor` (§12.2) |
| `POST /api/finance/subscriptions` | Manual add (`create_subscription`); body is the dialog fields plus `mailboxId` and optional `messageId`; returns `{ subscription, actionId }` |
| `GET /api/finance/subscriptions/[id]` | The row, its paid total for 12 months, and its documents with resolved message refs, `attachmentId` and whether each invoice or credit is paired (§12.2) |
| `POST /api/finance/subscriptions/[id]/documents` | Manual document from a message (`record_document`); body `{ messageId, docType, amountMinor, currency, documentOn, periodStartOn?, periodEndOn?, attachmentId? }`; 404 without full access to the message's mailbox or when `attachmentId` is not an attachment of that message; 409 `DOCUMENT_EXISTS`; returns `{ document, actionId }` |
| `DELETE /api/finance/documents/[id]` | `delete_document`; returns `{ actionId }` |
| `PATCH /api/finance/subscriptions/[id]` | `{ fields }` → `update_subscription`, `{ reminderDays, calendarReminder }` → variant `reminder`, `{ status }` → `set_subscription_status`; returns `{ subscription, actionId }` |
| `DELETE /api/finance/subscriptions/[id]` | `delete_subscription`; returns `{ actionId }` |
| `POST /api/finance/detect` | `{ messageId }` → the prefilled draft for "Track as subscription" and "Add to a tracked subscription" (subscription fields, `document`, the matched `subscriptionId` and the message's attachments); 404 without full access to the message's mailbox; writes nothing |
| `GET /api/finance/badge` | `{ count }` |

Input validation is zod in `src/lib/finance/api-schemas.ts` **(new)** with the same bounds as §5.4-§5.5 (dates within 2 years; manual entries may also be up to 5 years in the past for history) and §5.10 for documents (a positive amount for every type, a document date up to 5 years in the past and at most 1 day in the future, a period of at most 366 days with start ≤ end).

## 13. Ownership, visibility and contacts

### 13.1 Owner

The owner of a detected subscription is the suggestion's reviewer: `mailbox_agent_settings.reviewer_user_id`, else the mailbox owner, as copied to `agent_jobs.reviewer_user_id` and `agent_suggestions.reviewer_user_id`. The step runs with the reviewer as viewer and matches against the reviewer's rows. Manual rows belong to the user who adds them.

### 13.2 Who sees what

Subscriptions are financial data, so the recommendation (§23, question 7) is **reviewer only**:

- Suggestions are listed today to every user with full access to the mailbox. The `subscription` kind declares `audience: "reviewer"` (§16 C4), so its cards, row badges and For you counts appear only for the reviewer, and only the reviewer can accept them (`moduleHost.suggestions.get` checks it).
- Rows and their documents, the view, search, refs, tools and webhooks are owner-only; opening a document's attachment additionally needs read access to its mailbox (§12.2). Admins and the primary admin do not see other users' subscriptions in the UI; they are in admin backups like all other data (§18).

### 13.3 Contacts

Inbound delivery already upserts a contact for each sender. On accept, `moduleHost.contacts.find(ctx, ownerId, senderAddress)` **(new, §16 C10)** returns `{ id, displayName } | null`, and the row stores `contact_id`. Money Watch never creates or edits contacts. `contact:contact` refs do not resolve today, so the view shows the sender address with a link to search for its mail.

## 14. Refs, events, search, tools and scopes

| Surface | Money Watch contribution |
| --- | --- |
| Record refs | `finance:subscription` resolved by `src/lib/finance/refs.ts` **(new)**: label "Netflix · $17.99/month", `href: "/finance?subscription=<id>"` (passes `isSameOriginPath`); unavailable for anyone but the owner, for a missing row, before 0063 and while the module is off. Ledger rows get no record kind of their own in v1: document actions carry their subscription's ref. |
| Webhooks | `finance.subscription.detected` when a row is created (accept or manual), payload `{ subscription: { ref, vendor, plan, amount, cycle, status, nextRenewalOn, trialEndsOn }, source: "suggestion" \| "manual", message: ref \| null }`. `finance.subscription.renewal_due` from the cron, payload `{ subscription: {…}, due: { on, kind: "renewal" \| "trial_end", daysLeft } }`. Emitted with `moduleHost.emitWebhook` and the owner as viewer, so only the owner's webhooks receive them. Recording or removing a document emits no event in v1 (a `finance.document.recorded` event is a cheap follow-up, §23, question 8). |
| Search | Section "Subscriptions": owner rows whose vendor or plan matches (escaped `LIKE`), at most 10, as refs. Documents are not searched separately; their source messages are already in mail search. |
| Assistant and MCP | `list_subscriptions` (§4) through `mcp:finance-read`, including the 12-month paid totals. Write tools are deferred (§23, question 19). |
| Activity | Labels from `actionLabels` (including `record_document:<type>` and `delete_document`); targets resolved through the generic module ref collection (§16 C9). |
| Scopes | Registry-wide as for every module: toggling never invalidates a key; creating a key with `mcp:finance-read` while the module is off answers 400 `MODULE_DISABLED`. |

## 15. Gating: off means absent

| Surface | Install off or user restricted | Mechanism |
| --- | --- | --- |
| Sidebar item and count | Hidden; count not fetched | `nav-utils.ts` filters by enabled modules |
| `/finance` | 404 | `requireModulePage("finance")` in `src/app/(finance)/layout.tsx` |
| `/api/finance/*` | 404 (install: before auth; user: after `checkUser`) | `withModule("finance", …)` |
| Detection | Not run; job note `module_disabled:finance` | `runModuleTriageSteps` checks the reviewer |
| Model extension | Not merged into the triage request; `wantsModel` not invoked | `activeModelExtensions` checks the reviewer and the mailbox step switch (C15) |
| Existing cards, row badges, For you | Hidden | `hiddenSuggestionKinds` |
| Accept or undo of a Money Watch action | Refused with `module_disabled` | `answerSuggestion`, `undoModuleAction` |
| "Track as subscription" and "Add to a tracked subscription" in the reader | Absent | message-menu slots list enabled modules only (C13) |
| Palette commands | Absent | Registry commands filtered by state |
| Cron | Install off: `module_disabled` (debug log). User restricted: that user's rows skipped and untouched | `invokeCapability`, `isEnabledFor` |
| Notices, webhooks | None emitted; event list hides the events; subscribing answers 400 `MODULE_DISABLED` | Module code does not run |
| Tools and search | Not listed; no search section | Registry filters |
| Refs | Unavailable label | `resolveRecordRefs` |
| Calendar reminders already created | Kept | Calendar data |
| Data | Kept | No hook deletes anything |

Turning the module back on restores everything; reminders inside their window fire on the next tick.

## 16. Core changes (generic)

None of these mention Money Watch. Each lands with unit tests, and each changes Calendar only where noted. File paths are at `b8afdb8`; every type, field, hook, event and key this table introduces (for example `CoreSuggestionKind`, `suggestionKindMeta`, `audience`, `triage.automatic`, `triage.capability`, `capabilities.modules`, `reopensSuggestion`, `ModuleNoticeNotification`, `kite:module-notice`, the `sidebar` placement, `count`, `useModuleNavCounts`, the `message-menu` slot, `scheduledTime`, `triage.model`, `MODULE_EXTENSION_MAX_OUTPUT_TOKENS`, `activeModelExtensions` and `model_failed`) is **(new)**.

| # | Change | Files | Notes |
| --- | --- | --- | --- |
| C1 | **Store and validate module-owned suggestion kinds.** `SuggestionKind` becomes `CoreSuggestionKind \| (string & {})` (same for the `agent_suggestions.kind` TypeScript enum); `STORED_KINDS` becomes core kinds plus `suggestionKindOwners`; `parseSuggestionPayload` falls back to the owning descriptor's input schema (`capabilityInputSchema`) instead of indexing `PAYLOAD_SCHEMAS` (an unknown kind throws a TypeError today) | `src/lib/agent/auto-read/suggestion-types.d.ts:1-2`, `suggestions.ts:9`, `suggestion-utils.ts:41-95`, `src/db/schema/agent-auto-read.ts:21` | Without it a `subscription` suggestion is planned and silently not stored. No migration (no SQL CHECK). Update `tests/agent-auto-read-modules.test.mjs:131` (`suggestionKindOwners`). |
| C2 | **Suggestion UI from client data.** `ClientModuleData.suggestionKindMeta` (new: `label`, `reason`, `badgePriority`, `icon`) drives `BLOCK_KINDS`, `FOR_YOU_KIND_LABELS`, `BADGE_PRIORITY`, `SUGGESTION_KIND_ORDER`, badge chips and `REASON_TEXT`; module kinds render through the existing `ModuleBlock` | `src/components/agent/suggestion-card-utils.ts:5`, `src/lib/agent/auto-read/for-you-utils.ts:4`, `suggestion-badge-utils.ts:4-7`, `src/components/agent/agent-activity-utils.ts`, `for-you-view.tsx:161` | Calendar adds its own meta; behaviour unchanged. |
| C3 | **Step-supplied titles.** Step output suggestions may carry `title` (≤ 120, control and bidi characters stripped by core); otherwise the kind's `label` | `src/lib/modules/shared-schemas.ts:38-68`, `module-steps-utils.ts`, `suggestion-utils.ts:78` (`STATIC_TITLES`) | `title` is NOT NULL today and `STATIC_TITLES` has no entry for a module kind. |
| C4 | **Reviewer-only kinds.** `suggestionKind.audience?: "mailbox" \| "reviewer"` (default `mailbox`); listing, row badges on `/api/messages`, For you counts and `loadForDecision` hide or refuse `reviewer` kinds for anyone but `reviewer_user_id` | `src/lib/modules/module-types.d.ts:163`, `src/lib/agent/auto-read/suggestion-visibility.ts`, `suggestion-api.ts:128`, `src/app/api/messages/route.ts` | Private financial data in shared mailboxes. |
| C5 | **Wider triage-step input.** `message.fromName`, `message.textExcerpt` (≤ 8 KB), `facts.automatic/noReply/list/spam`, `headers.listUnsubscribe/listUnsubscribePost/listId` from the already-loaded `readRawHeaders` map | `shared-schemas.ts:38-68`, `src/lib/agent/auto-read/module-steps.ts:45-77`, `triage-context.ts` (loads the headers at line 45 but does not return them yet) | No new R2 read; extra keys are stripped for Calendar. |
| C6 | **Automatic mail reaches opted-in steps.** `triage.automatic?: true` on a step. `triageMessageGate` keeps skipping `Auto-Submitted` mail unless an opted-in step's module is enabled for the reviewer; `processAgentTriageJob` then runs a steps-only pass for automatic mail (no core kinds except phishing; no model unless an active extension's `wantsModel` hint asks for it, C16). Bulk, list and no-reply mail already pass the gate | `src/lib/agent/auto-read/schedule-utils.ts:22-35`, `schedule.ts`, `process.ts:81-145`, `src/lib/modules/module-types.d.ts:165` | Most receipts carry `Auto-Submitted: auto-generated`. Steps-only jobs count toward the daily job limit (§23, question 17). |
| C7 | **Steps run when the model is refused or fails.** On `external_provider_not_allowed`, `rate_limited` or `spend_cap`, run module steps with `model: null`, store their suggestions, and record the model skip in the job note instead of skipping the whole job. On a model error after the in-request repair (invalid output, truncation, timeout, provider error): when the request was made only because of a `wantsModel` hint (C16), do not retry; record `model_failed` in the note and run the steps with `model: null`. When today's `needsModel` required it, keep the existing retry (`MAX_ATTEMPTS` = 3, `src/lib/agent/jobs/lease.ts:10`) and, on the last attempt, run the steps with `model: null` instead of failing the job | `process.ts:102-104` (returned skips), `process.ts:163-165` (`SpendCapReachedError`, `ExternalProviderNotAllowedError`), `src/lib/agent/jobs/lease.ts:50-52` | Also lets Calendar invites through when the model is refused or keeps failing (§23, question 18). A hint never causes a retry, so it cannot multiply spend. |
| C8 | **Per-mailbox module step switch.** `triage.capability?: string` names a key in a new `capabilities.modules` map (default `true`) in the mailbox capabilities JSON; `STEP_CAPABILITY` falls back to it; the automatic-reading settings list one switch per enabled module step from client data | `module-steps.ts:16,37-43`, `src/lib/agent/auto-read/settings-types.d.ts:3-10`, `settings-utils.ts:14` (`CAPABILITY_KEYS`), `src/components/agent/auto-read-settings.tsx` | Calendar keeps its existing `calendar` key. |
| C9 | **Module action types and Activity refs.** `AgentActionType` becomes core types plus `string` (module types validated against `ACTION_REGISTRY`); Activity collects `result.ref`/`after.ref` of any module action instead of `CALENDAR_ACTIONS`; `action.reopensSuggestion?: boolean` reopens the suggestion after an undo when no live action of that module remains | `src/lib/agent/auto-read/policy-types.d.ts:6`, `src/db/schema/agent-auto-read.ts`, `activity-ref-utils.ts:4`, `src/lib/agent/auto-read/activity.ts`, `execute.ts:323` | Matches module-platform §11.2's "core types plus string". |
| C10 | **ModuleHost additions** (below) | `src/lib/modules/host-types.d.ts`, `host.ts`, `host-services.ts` | Each checks `ctx.viewer` and, where a mailbox is named, `ctx.mailboxIds` or mailbox access. |
| C11 | **Module notices over realtime.** `RealtimePayload` gains `ModuleNoticeNotification`; the client toasts it and dispatches `kite:module-notice` | `src/lib/realtime/types.d.ts:27`, `src/lib/realtime/utils.ts`, `src/hooks/use-message-polling.ts:96`, `src/hooks/message-realtime-utils.ts` | Works on the Durable Object and the Node hub alike. |
| C12 | **Sidebar placement with a count.** `ModuleNavPlacement` gains `"sidebar"`; `ModuleNavItem.count?: { endpoint }` must start with one of the module's API prefixes (registry test); `dashboard-nav.tsx` renders enabled modules' sidebar items under For you with `NavLink count`, fetched by a generic `useModuleNavCounts` | `module-types.d.ts:21-34`, `src/lib/modules/nav-utils.ts`, `src/components/dashboard-nav.tsx`, `src/components/modules/client-registry.ts` (`NAV_ICONS` gains `WalletCards`) | |
| C13 | **Message menu slot.** A `message-menu` slot (manifest `messageSlots`, client data `messageSlots`) rendered by the reader's overflow menu through the same lazy client-chunk mechanism as `ComposerSlot`; the slot component receives `{ messageId, mailboxId }` only | `module-types.d.ts:68-77`, `src/components/compose/composer-slot.tsx` (shared loader), `src/components/message-actions/message-actions.tsx` | |
| C14 | **Cron input carries the tick time.** `runModuleCronTasks` passes `{ scheduledTime }` (ISO) instead of `{}`; there is no shared cron input schema, so Money Watch's own `remindRenewals` schema allows it as optional | `src/lib/modules/background-utils.ts:90` | Lets unit tests and the Miniflare `time` parameter drive the reminder clock. Import ignores it: its `resumeStalledImports` input is `z.object({})` (`src/lib/modules/import/schemas.ts:12`), which strips the key. |
| C15 | **Module model extensions for triage steps.** `triage.model?: { jsonSchema, instructions, maxOutputTokens, wantsModel? }` on a `triage_step` descriptor (JSON only). `activeModelExtensions` selects the extensions whose module is enabled for the reviewer and whose per-mailbox step switch (C8) is on. For a request with active extensions, core merges each `jsonSchema` under `properties.modules.properties.<moduleId>` of the per-request provider schema, appends each `instructions` string to the system prompt's key list (outside the untrusted block), raises the output cap by the sum of `maxOutputTokens` capped at `MODULE_EXTENSION_MAX_OUTPUT_TOKENS` = 200, parses `modules` leniently (active keys only, ≤ 2 KB each, never a parse failure or repair), and passes each step only its own `model.modules.<id>` | `src/lib/agent/auto-read/triage-model.ts:17` (`TRIAGE_JSON_SCHEMA` becomes a builder), `triage-utils.ts:30` and `:56` (`triageResultSchema`, `TRIAGE_SYSTEM_PROMPT`, `buildTriagePrompt`), `model-call-utils.ts:9` and `buildOptions`, `triage-run.ts`, `module-steps.ts`, `src/lib/modules/module-types.d.ts:165`, `tests/module-registry.test.mjs` (declaration rules, §5.7.1) | Without an active extension the schema, prompt and the 400-token cap are byte-for-byte today's. Calendar declares none. The module validates the object itself; core never interprets it. |
| C16 | **`wantsModel` hints.** When an active extension names a `wantsModel` service capability, core invokes it with the step input (`model: null`) before `modelStep`; the request is made when `needsModel` is true or any hint is true (never for a muted sender or a `spam` verdict), including on the C6 steps-only pass. When only a hint asked, core plans its own kinds as if the model had not run, and a failure is not retried (C7). A hint that throws, times out or answers anything but `{ wantsModel: true }` counts as false | `src/lib/agent/auto-read/facts-utils.ts:174` (`needsModel` gains a `hinted` argument), `process.ts:59` (`modelStep`), `module-steps.ts` | Every existing gate stays in place and in order: autonomy, kill switch, pause and daily limit at job start; external opt-in per request; rate limit; spend reservation against the mailbox and install caps (§5.7.5). |

Descriptor addition (C15), **(new)**:

```ts
type TriageStepDeclaration = ExistingTriageStepDeclaration & {
	automatic?: true;                 // C6
	capability?: string;              // C8
	model?: {
		/** JSON Schema for the module's object, merged under properties.modules.properties.<moduleId>; §5.7.1 rules. */
		jsonSchema: JsonObject;
		/** Appended to the triage system prompt's key list; ≤ 600 printable characters, static data. */
		instructions: string;
		/** Extra output tokens this extension may use, 1..200; the total across extensions is capped at 200. */
		maxOutputTokens: number;
		/** A `service` capability of the same module returning { wantsModel: boolean } for the step input. */
		wantsModel?: string;
	};
};
```

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

Tests and lists that hard-code the four modules gain `finance` (§17, steps 13 and 14): `tests/module-registry.test.mjs` (`IDS`, surface counts, command list, manifest assertions), `module-imports` (`MODULE_IDS`, `MODULE_CODE` gains `src/lib/finance`), `module-route-guard` (layouts), `module-state`, `agent-chat-tools`, `module-admin`, `module-webhooks`, `module-commands`, `module-search-lifecycle`, `module-composer-slots`, `module-nav`, `module-jmap`, `backup-module-tables`, `module-capabilities`, `module-migration` ("0062 last" becomes "0063 last", or the rebased number if attachments-once merges first, §7.3), `src/lib/modules/client-data/module-ids.ts`, `e2e/support/modules.ts` and the four-module assertions in `e2e/27-modules.spec.ts`.

## 17. Module files

Following the 14 steps of "Adding a builtin module" (`docs/modules.md:68-87`). Every file named here is **(new)** except the existing lists and registries it is added to:

| Step | Files |
| --- | --- |
| 1 Id | `ModuleId` in `src/lib/modules/module-types.d.ts:1`; `MODULE_IDS` in `src/lib/modules/client-data/module-ids.ts` (after `import`) |
| 2 Client data | `src/lib/modules/client-data/finance.ts`; `CLIENT_MODULES` in `client-data/index.ts` |
| 3 Manifest | `src/lib/modules/finance/manifest.ts`; `MODULE_MANIFESTS` in `registry.ts` |
| 4 Schemas | `src/lib/modules/finance/schemas.ts`, including `financeModelSchema` and the JSON fragment generated from it (§5.7.1) |
| 5 Descriptors | `src/lib/modules/finance/capabilities.ts` (with `triage.model` on `detect` and the `wantsModel` service); `MODULE_CAPABILITIES` in `capability-registry.ts` |
| 6 Handlers | `src/lib/modules/finance/server.ts`; `SERVER_MODULES` in `server-registry.ts` |
| 7 Core services | Only `moduleHost` (§16 C10) |
| 8 Record kinds | `finance:subscription` in `RecordKind`; `src/lib/finance/refs.ts` |
| 9 Client code | `src/components/modules/finance/client.ts` (`suggestionCards.subscription` `{ Block, Answered }`, the two message-menu slot components, the add and document dialog loaders) in `MODULE_CLIENTS` with the inline `typeof window` check; `NAV_ICONS.WalletCards` |
| 10 Composer slots | None (a `message-menu` slot instead, C13) |
| 11 Cron | `cronTasks` entry plus the `remindRenewals` descriptor |
| 12 Guards | `src/app/(finance)/layout.tsx`, `src/app/(finance)/finance/page.tsx`, `src/app/api/finance/**/route.ts` with `withModule`; `npm run docs:generate` |
| 13 Tests | §20 |
| 14 Data and backups | `src/db/schema/finance.ts`, `drizzle/migrations/0063_add_finance_module.sql`, journal, backup lists (§8) |

Implementation in `src/lib/finance/` **(new)**: `detect.ts` (step handler: matching, history, PDF orchestration, merge), `detect-utils.ts` (including `wantsModelForReceipt`), `model-utils.ts` (`parseModelExtraction`, `mergeDetection`), `document-utils.ts` (`classifyDocument`: type, date, period, attachment, §5.10), `keywords-utils.ts`, `amount-utils.ts`, `date-utils.ts`, `vendor-utils.ts`, `cancel-link-utils.ts`, `pdf-text-utils.ts`, `text-utils.ts`, `totals-utils.ts` (monthly and yearly totals, `paidLast12Months` and pairing), `reminder-utils.ts` (window and due-date maths per time zone), `actions.ts` (execute and undo for the subscription action capabilities), `document-actions.ts` (`recordDocument`, `deleteDocument`), `answer.ts`, `reminders.ts` (cron), `subscriptions.ts` and `documents.ts` (queries), `api-schemas.ts`, `refs.ts`, `search.ts`, `tools.ts`, `webhook-events.ts`, `types.d.ts`. Every `*-utils.ts` is added to `gated` in `scripts/quality/coverage-config.json`. Each file stays under 500 lines and each function under complexity 20 (`quality:check` baselines). Calendar gains `src/lib/calendar/reminders.ts` plus two descriptors and handlers in `src/lib/modules/calendar/`. Nothing in this mission adds a Drive call or a Drive-related file (§24).

## 18. Security and privacy

- **Untrusted input.** Mail is attacker-controlled. Detection is regex and arithmetic over bounded text (subject ≤ 300, excerpt ≤ 8 KB, history excerpts ≤ 4 KB, PDF text ≤ 64 KB) with linear-time patterns. The hostile corpus in `tests/fixtures/agent-injection/` gains receipt-shaped cases checked by the unit tests (an "invoice" asking to add a link, oversized amounts, far-future dates, bidi vendor names).
- **Model output is untrusted too.** The extension rides the existing triage request, so the email stays in the nonce-delimited untrusted block and the extension's instructions are static descriptor data outside it (§5.7.3). Whatever comes back under `modules.finance` is validated field by field (§5.7.4): unknown keys are stripped, invalid fields are absent, amounts and dates are bounded, the currency is allowlisted and the cycle is a closed enum. A prompt injection can at worst change a value the detector left empty (including a document type the subject and attachment names left open), inside those bounds, on a card the user still has to accept; it can never set the cancel link, the vendor key, the document attachment, a failed payment, the owner, or create a card without deterministic billing evidence (§5.7.4, rules 4 and 6). Disagreement on the amount or currency is shown, not resolved in the model's favour. `scripts/agent/injection-eval.mjs` gains the receipt-shaped corpus cases so they also run against a real model (not part of CI).
- **Links.** The only stored URL is the `https` `List-Unsubscribe` link with no IP literal, local hostname or credentials. It is never fetched or POSTed by Kite and opens only on a click with `noopener,noreferrer`, after showing its host. Body links are never used. Vendor and plan text is rendered as text, never HTML.
- **Phishing and spoofing.** Phishing-flagged and spam mail produce no card; unauthenticated senders get the "Unverified sender" warning; the values on the card are what code extracted or validated, and model-filled values are marked (§5.8). The model is never asked about phishing-flagged or spam mail for this extension (the hint refuses both, §5.7.2).
- **Access.** Rows are owner-only in every surface (API 404, refs unavailable, search, tools, webhooks to the owner's own endpoints). Cards are reviewer-only (C4). Accept and edits need `manage` on the audit mailbox. The calendar service writes only the viewer's own calendar.
- **Stored data.** Vendor, plan, amounts, dates, the cancel link, links to messages, and per document its type, amount, dates and an attachment id. No card numbers: the detector does not extract digits other than amounts and dates, and stores no excerpt. No file content: the ledger references the attachment, never copies it, and opening it goes through the existing attachment route and `getAttachmentForUser`, so it can never show a file the user cannot already open in the mailbox. `docs/privacy.md` ("What is stored where") and `docs/pii-handling.md` ("Storage and scope") gain the two tables. Account deletion cascades; message deletion keeps the document's amount, type and date but drops the message link and with it the attachment link; turning the module off keeps everything. Admin backups contain the tables like every other user data, and restore follows §8.
- **Logs.** Structured logs (`src/lib/logger.mjs`) carry ids and codes only, never vendor, amounts, dates or URLs. Prompts and model responses, including the extension object, are not persisted or logged, as for every triage request; only `ai_usage` rows are written.
- **External providers.** The extension sends nothing the triage request does not already send (subject, sender, body excerpt and facts), but the hint can send receipt-like bulk and automatic mail that is not sent today. That only happens with a compatible (external) provider when the install has `agent_external_auto_read_allowed` on, re-checked on every request; the per-mailbox switch (C8) keeps the step, and with it the extension, off for a mailbox.
- **Spend.** C6 and C7 add triage jobs for automatic mail, which count toward the per-mailbox daily job limit. The model requests the hint adds (§5.7.5) are reserved and settled in `ai_usage` against the mailbox and install caps like every triage request, are rate limited, are never retried on failure (C7), and use at most 200 extra output tokens. Spend can grow only within the existing caps.

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
| `tests/finance-detect.test.mjs` **(new)** | Signals and threshold; one-off receipts rejected; amounts (separators, minor digits, symbols, `$` disambiguation, bounds); dates (formats, day-first rules, 2-year bound, no-year rollover); cycles and inferred cycles; vendor and vendor key (processors, public suffixes); payment-failed; titles (including the `refund` event); hostile inputs; phishing and spam skips; credits, refunds and failed payments from an untracked vendor give no card; a credit or refund for a tracked row is a `refund` event and never a `price_change`. |
| `tests/finance-document.test.mjs` **(new)** | `classifyDocument`: each type in each of the five languages; precedence (`refund` > `credit` > `payment` > `invoice`, "Invoice #123 paid" is a `payment`, "Refund for your payment" is a `refund`); payment-failed phrases always win; subject and filename confident, body-only weak; no match gives `document: null`; amount required except for `failed_payment`; document date labels and the −400/+1 day bound with the message-date fallback; period ranges (separators, start after end, longer than 366 days, out of bounds); attachment choice (keyword PDF, then image, then a lone PDF, else null). |
| `tests/finance-totals.test.mjs` **(new)** | Monthly and yearly totals per cycle and currency; `paidLast12Months`: payments add, refunds subtract, failed payments never count; an invoice and its payment for the same stated period count once; without periods, equal amounts within 31 days pair and 32 days do not; one payment pairs with one invoice only (two invoices, one payment); an auto-charged invoice without a receipt counts; credit and refund pair the same way; window edges in the owner's time zone (exactly 12 months ago included, tomorrow excluded); currencies kept apart; cancelled subscriptions still count; negative results. |
| `tests/finance-model.test.mjs` **(new)** | `wantsModelForReceipt`: score and threshold, keyword or attachment required, complete detections ask for nothing, phishing and spam never ask. `parseModelExtraction`: non-object absent, unknown keys (`cancelUrl`, `link`) stripped, each field invalid on its own (vendor bidi and length, plan length, amount pattern, minor digits per currency including JPY and BHD, zero, negative and over-bound amounts, currency outside the allowlist, cycle outside the enum, impossible dates such as `2026-02-30`, renewal before the message minus 1 day, trial end before the tolerance, dates more than 2 years out). `parseModelExtraction` also checks `docType` (outside the enum absent, `failed_payment` absent without the deterministic phrases). `mergeDetection`: confident deterministic values win, empty fields filled, domain-fallback vendor, estimated renewal and body-only document type replaced, a model `credit` or `refund` on a tracked vendor gives a `refund` event, amount and currency conflicts kept deterministic with `modelDisagrees` and the `subscription_check_amount` reason, payment-failed keeps its reason, vendor key, event and cancel link never taken from the model, `modelFields` and `model_fields` recorded, rule 6 candidate condition (model alone never a candidate). |
| `tests/finance-cancel-link.test.mjs` **(new)** | `List-Unsubscribe` parsing: https kept, http/mailto/IP/localhost/credentials dropped, one-click only for the exact RFC 8058 value. |
| `tests/finance-pdf.test.mjs` **(new)** | Text from small fixture PDFs (plain and Flate), encrypted skipped, truncated skipped, inflate and stream caps, time cap. |
| `tests/finance-reminders.test.mjs` **(new)** | Due-date choice (trial versus renewal), window per time zone across DST, claim idempotency, missed reminders claimed silently, per-user restriction leaves rows untouched, calendar off skips the event, failures do not stop the loop (bundled with a SQLite database). |
| `tests/finance-module.test.mjs` **(new)** | Step handler end to end on fixtures; answer service (track, update, record, mark urgent, stale suggestion, wrong reviewer, a stale `attachmentId` dropped); actions execute/undo/authorize idempotent by `actionId`; ledger writes (one row per subscription, message and type, `ON CONFLICT DO NOTHING`, undo removes only the rows its action inserted, a credit leaves price and renewal unchanged, a payment clears `payment_failed_at`); `record_document` and `delete_document` with undo; `DOCUMENT_EXISTS`; delete snapshot restore; refs owner-only; search; `list_subscriptions`; webhooks emitted with the owner. |
| `tests/finance-migration.test.mjs` **(new)** | `copyMigrationsBefore(scratch, 63)` (the rebased number if it moves, §7.3): pre-0063 backup restores after 0063 with empty tables; post-0063 round-trip with every ledger column, including `attachment_id`, `doc_type`, the period columns and a null `filed_ref`; FK order (`users`, `mailboxes`, `contacts`, `messages`, `calendar_events` before `finance_subscriptions` before `finance_charges`); `mail` group membership; pre-0063 database reads as "nothing yet". |
| `tests/calendar-reminders.test.mjs` **(new)** | `upsertReminder` insert, update, no duplicate under repeated calls, key validation, `userId` must be the viewer; `removeReminder`; webhooks emitted. |
| Core (C1-C14) | `tests/agent-auto-read-modules.test.mjs` (stored module kind, payload fallback, step title, audience, steps-only automatic job, steps after a refused model, steps after a failed model on the last attempt, mailbox module switch, reopen on undo, Activity refs), `tests/module-queue-cron.test.mjs` (`scheduledTime`), registry tests for `sidebar`/`count`/`messageSlots`, realtime payload test, host service tests. |
| Core (C15-C16) | `tests/agent-auto-read-model-extension.test.mjs` **(new)**, with a test-only module descriptor so it names no real module: schema merge (no `modules` key without an active extension, so the schema, prompt and cap equal today's; the fragment appears under `properties.modules.properties.<id>` only when the module is on for the reviewer and the mailbox step switch is on; two extensions merge side by side; `modules` never required); prompt (instructions appended before the closing line, outside the untrusted block, the email still delimited by the nonce); output cap 400 → 600, total extension allowance capped at 200; lenient parse (inactive keys dropped, > 2 KB values dropped, invalid `modules` neither fails the parse nor triggers the repair); hand-off (each step sees only its own key); hints (`needsModel` false plus hint true makes the request, muted sender and `spam` verdict never, a throwing or slow hint counts as false, core kinds planned as if the model had not run, no retry after a hint-only failure); every gate still refuses (kill switch, external opt-in re-checked per request, rate limit, spend cap reservation and settlement in `ai_usage`). Registry rules for `triage.model` in `tests/module-registry.test.mjs` (§5.7.1). |

Coverage: every new `*-utils.ts` is gated (branches ≥ 70%, functions ≥ 80% per file) without lowering the aggregate (branches ≥ 90%).

### 20.2 End to end

New `e2e/28-finance.spec.ts` **(new)**, serial (it restores a backup it takes), using its own account from `createSignedInAccount` with autonomy `suggest`, mail delivered through `deliverInbound` with `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted` and `Authentication-Results` headers, and the cron triggered with `GET /cdn-cgi/handler/scheduled?cron=*/5%20*%20*%20*%20*` (polling for the effect). Realtime frames are recorded with the socket recorder pattern of `e2e/26-one-time-code.spec.ts:84`. Assertions use unique tokens, never the seeded billing-mailbox messages (such as the received "Invoice address update"), which the seed inserts directly, so they are never triaged. The model runs against the existing fake model (`e2e/support/fake-model.ts`, served standalone by `scripts/agent/fake-model-server.mjs`), configured as in `e2e/23-auto-agent.spec.ts` with `AI_ALLOW_INSECURE_LOOPBACK` and the external opt-in on; messages pick a scenario with the `[[scenario:<name>]]` marker. `e2e/support/fake-model-scenarios.ts` gains `finance-receipt` (valid core fields plus a `modules.finance` object with vendor, plan, amount, currency, cycle, dates and `docType: "payment"`), `finance-conflict` (a different amount, a `cancelUrl` key and an impossible date) and `finance-invalid-extension` (valid core fields, `modules.finance` not an object). Requests are inspected through the recorder (`fake.requests()`).

1. **Detects and tracks with undo:** an automatic invoice ("$17.99/month, renews …") produces a `subscription` card with the expected title in the reader and For you, and the fake model records no request for it (the detector was complete, so the hint did not ask); Track creates the row and its `invoice` ledger row (API and view), Activity shows "Started tracking a subscription", Undo removes both and reopens the card.
2. **Second invoice, then a refund, in the ledger:** with case 1's card tracked again, a later invoice at $19.99 with an `invoice-<token>.pdf` attachment produces "now $19.99/month, up from $17.99"; accepting updates the renewal date and shows "Increased from $17.99", and the drawer lists both invoices, with **Open document** answering 200 with the PDF for the owner. Paid in the last 12 months reads $37.98. A refund mail ("Your refund of $19.99 …") from the same sender produces "… refunded $19.99. Record it?"; Record it adds a "Refund −$19.99" entry, the 12-month total drops to $17.99, and the price, renewal date and status are unchanged; Undo removes the entry and restores $37.98.
3. **Payment failed:** the card marks the row urgent; it appears under Needs attention and in the badge.
4. **Manual add:** by hand from `/finance`, from a message through "Track as subscription" with the prefilled cancel link, and a payment receipt from another message through "Add to a tracked subscription" (the matched row preselected); all undoable, and adding the same receipt twice shows the "already recorded" error.
5. **Renewal nudge:** a row renewing in 2 days with 3 reminder days; the cron tick produces one `module_notice` frame and toast, badge count 1, and a calendar event "… renews" on the due date; a second tick produces no second notice or event.
6. **Calendar off for the user:** the reminder still notifies, no calendar event is created, and the row keeps working.
7. **The view:** lists items in due order with totals and the 12-month paid total, edits a reminder (Off → 7 days), "Cancel before …" opens a popup on the header's https URL (no server request to it, checked with a route recorder), then "Mark as cancelled" moves it to Cancelled.
8. **Cancel link only from the header:** a body link with no header gives no cancel link; an `http:` header gives none.
9. **Reviewer only:** a user with full shared access sees no Money Watch card and gets 404 accepting it.
10. **Off means absent:** install off, then user restricted: nav item, `/finance` (404 page), `/api/finance/*` (404), cards, the message menu item, palette commands, `list_subscriptions`, search section and webhook events are gone; the cron tick leaves rows untouched and sends no notice; on again restores all.
11. **Model refused still detects:** with the external provider not allowed, a personal non-bulk receipt still yields the card (C7).
12. **Backup round-trip:** both tables in `includedTables`, restore brings rows back, including the ledger rows with their document type and attachment reference.
13. **Kite, Classic and dark mode:** the view, the card and the dialog render without overflow in all three.
14. **The model fills the gaps:** an automatic "Your receipt from <token>" with "$9.99" and no cycle or date (`[[scenario:finance-receipt]]`) makes exactly one triage request whose recorded body has the `modules.finance` schema fragment, the extension instructions in the system message and `max_tokens` 600; the card reads "<token> $9.99/month, renews …" and the tooltip marks the cycle and date as read by the assistant; the subject "Your receipt from <token>" already classifies the document as a `payment` (confident), so the model's `docType` is not listed in `modelFields`. The same message with the mailbox's Money Watch switch off makes no request and no card.
15. **Model output never wins a conflict or sets the link:** `[[scenario:finance-conflict]]` on a receipt with a deterministic $9.99 and no `List-Unsubscribe` header gives a card with $9.99, "Check the amount before tracking", no cancel link and no date from the model; `[[scenario:finance-invalid-extension]]` gives the deterministic-only result, with no repair request recorded.
16. **Gates hold for the extension:** with the external opt-in off, and again with the mailbox spend cap at its limit, the receipt from case 14 makes no model request, its job note names the skip, and the step still runs on the deterministic result (no card, because the detector alone is incomplete); Activity shows the plain-words reason.

`e2e/27-modules.spec.ts` gains `finance` in its module lists and counts (session list, Modules page, `toHaveCount(5)`, `ALL_MODULES_OFF`, signed-out 401 for `/api/finance/subscriptions`, the mail-only install and backup tests) and an `offThenOn` case for Money Watch nav, page and API. `e2e/support/modules.ts` gains the id, `e2e/global-setup.ts` adds `/finance` to `WARM_UP_ROUTES`, and `e2e/README.md` gains the new file. No `e2e/timings.json` entry is needed until the first CI run.

### 20.3 Manual

`npm run dev` with `npm run db:seed` and the standalone fake model (`node scripts/agent/fake-model-server.mjs --port 3301`, compatible provider, external opt-in on), deliver a few synthetic receipts, including one that needs the model extension, check the card, the view, the toast and the calendar event in Kite, Classic and dark mode, and run `npm run check:mission` (validate-kite skill) before review. Check the bundle budget after `npm run build`.

## 21. Documentation

| Document | Change |
| --- | --- |
| `docs/modules.md` | "The four modules" becomes five with a Money Watch row; what off does for it; the database update note names 0063. |
| `docs/assistant.md` | The `subscription` suggestion kind (Track, Record it for credits and refunds, Mark urgent) and the documents it records, reviewer-only cards, detection on automatic mail, the per-mailbox switch; when receipt-like mail is sent to the model (only when the detector needs help, under the external opt-in and spend caps) and how model-filled values are marked. |
| `docs/specs/auto-agent.md` | Lines 20, 41, 80-82, 199, 252, 275 and 410-418: module kinds, the cancel-link rule, steps-only jobs, module model extensions and `wantsModel` hints, the raised output cap, steps after a refused or failed model. |
| `docs/specs/module-platform.md` §11.2 | The wider step input, `triage.automatic`, `triage.capability`, `triage.model` (schema fragment, instructions, token allowance, `wantsModel`), `audience`, `reopensSuggestion`, step titles, the new host services, `sidebar` placement and `message-menu` slots. |
| `docs/modules.md` "Adding a builtin module" | A note on declaring a model extension for a triage step and validating its object in the module. |
| `docs/privacy.md`, `docs/pii-handling.md` | The two tables, including that the document ledger stores attachment references and never file content, owner-only access, deletion behaviour (contract docs: paths are checked). |
| `CLAUDE.md` | Modules and automatic-reading sections (five builtin modules, suggestion kinds, module model extensions and hints, the output cap, backups bullet). |
| `CHANGELOG.md` | Unreleased: apply migration 0063; **Money Watch** under Added with a link to [/finance](/finance), naming subscriptions, their invoices, payments, credits and refunds, and the 12-month paid total. |
| `ROADMAP.md`, `docs/roadmap-complete-suite.md` | Milestone 18 marked shipped with the PR, with the module id `finance`, the `finance.subscription.*` event names, the model extension and the document ledger; one-off purchases and general expense tracking listed as a later item; automatic Drive filing (§24) listed under Drive's milestone 7 as a follow-up; milestone 24 notes the planned separate `portfolio` module. |
| `e2e/README.md` | Row for `28-finance.spec.ts`; `27-modules` lists five modules. |
| `docs/specs/drive-storage.md` | Its planned 0063 and 0064 move to the next free numbers after Money Watch (0063) and attachments-once (0064 or later); a follow-up note links to §24 for the filing service Drive should provide. No Drive code changes. |
| `docs/api-inventory.md`, `src/lib/metrics-routes.generated.json` | Regenerated by `npm run docs:generate`. |

## 22. Delivery plan

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **M1: core generalisation and the empty module** | C1, C2, C3, C5, C8, C9, C14; module id, client data, manifest, descriptors with stub handlers, `finance_subscriptions` and `finance_charges` with every ledger column (including the unused `filed_ref`), migration 0063 (rebased if attachments-once merged first, §7.3), backup lists, every hard-coded module list | `npm run check` green; registry, import, route-guard, migration and backup tests pass; Admin → Modules shows five modules; `27-modules` passes with five in its lists and counts (its Money Watch `offThenOn` case and the signed-out `/api/finance/subscriptions` check are added once those routes exist, M2-M3); Calendar behaviour unchanged. |
| **M2: detection, tracking and the ledger** | Deterministic detector (§5, without PDF) with document classification (§5.10), C4, C6, C7, C10, C13; step, card, answer service, the six actions with undo and reopen, price change, payment failed, credits and refunds (`refund` event, Record it), ledger writes and dedupe, `paidLast12Months`, manual add of subscriptions and documents (API, dialogs, both message-menu items), contacts link, refs, `finance.subscription.detected`, Activity | e2e cases 1-4, 8, 9 and 11, asserted through the card, the API and Activity (their `/finance` view, drawer, "Needs attention" and badge assertions are added in M3); unit tests for detector, document classification, totals, cancel link and module handlers. |
| **M2b: the model extension** (its own commit right after M2, before M3 starts) | C15, C16 and the model-failure half of C7; `triage.model` on `detect` (including `docType`), the `wantsModel` service, `financeModelSchema`, `model-utils.ts` (validation and merge), the `subscription_check_amount` reason, `modelFields`/`modelDisagrees` on the payload and card, the three fake model scenarios | e2e cases 14-16 and case 1's "no request" assertion; `tests/finance-model.test.mjs` and `tests/agent-auto-read-model-extension.test.mjs`; with no active extension the triage request is unchanged (asserted on the recorded request in `e2e/23-auto-agent.spec.ts` staying green); the cost note in §5.7.5 checked against the recorded `ai_usage` rows of case 14. |
| **M3: the view and the nudges** | `/finance` view, totals including the 12-month paid total, the drawer's document history with Open thread and Open document; C11, C12; `remindRenewals`; Calendar `upsertReminder`/`removeReminder`; badge; cancel button; `finance.subscription.renewal_due`; search; `list_subscriptions` | e2e cases 5-7, 10, 12 and 13; reminder and calendar unit tests; checked in Kite, Classic and dark mode. |
| **M4: attachments, hardening and docs** | PDF extraction (§23, question 6), hostile corpus cases (including receipt-shaped injection cases for `scripts/agent/injection-eval.mjs`), performance check of the step on a large mailbox, documentation (§21), CHANGELOG, timings refresh | `npm run check:mission` green locally; bundle within budget; docs check passes. |

Each milestone is one or more commits on `mission/money-watch`; nothing is pushed to `main`. Drive filing (§24) is in no milestone: it belongs to a mission after Drive ships.

## 23. Decisions and defaults

### Decisions (approved 2026-10-14)

The spec is approved as written, except for these decisions, which the sections above already apply:

1. **Module id `finance`** (was `money`), keeping the display name "Money Watch". Derived names: page `/finance`, API prefix `/api/finance`, grants `finance.read`/`finance.write`, record kind `finance:subscription`, scope `mcp:finance-read`, tables `finance_subscriptions` and `finance_charges`, migration `0063_add_finance_module.sql`, directories `src/lib/modules/finance/`, `src/lib/finance/` and `src/components/modules/finance/`, route group `(finance)`. The later read-only portfolio (milestone 24) is expected to be a separate `portfolio` module (§2).
2. **Webhook events `finance.subscription.detected` and `finance.subscription.renewal_due`**, the `<id>.<record>.<event>` pattern.
3. **The model extension is in v1** (§5.7): a generic, descriptor-declared extension of the triage request (C15) with a deterministic `wantsModel` hint (C16), validated and merged in the module, under every existing gate, delivered in M2b.
4. **A basic document ledger is in v1** (§5.10, §7.2, §9, §12.2). `finance_charges` holds one row per money document (`invoice`, `payment`, `credit`, `refund`, `failed_payment`) linked to one tracked subscription, with a positive amount whose sign comes from the type, the document date, the stated period, the source message and a reference to the attachment that is the document, never a copy. One row per subscription, message and type. Detection classifies the type deterministically (and the model extension may fill `docType`); still at most one card per message; credits and refunds record the document and reduce totals but never change the price or renewal date. The view adds "paid in the last 12 months" per currency (payments plus unpaired invoices, minus refunds and unpaired credits) and the documents in each vendor's history; documents can be added by hand from any message.
5. **One-off purchases and general expense tracking come later** (an advanced feature), not in this mission (§1).
6. **Automatic Drive filing is a follow-up after Drive ships** (§24): every ledger row with an attachment reference, including a backfill of earlier rows, is filed into the owner's Drive under `Finance/<vendor>/<year>/`. This mission adds only the unused nullable `filed_ref` column and calls no Drive code.
7. **Migration 0063 (journal `idx` 66) is claimed by this mission**; `mission/attachments-once` runs in parallel with 0064 or later, and whichever merges second rebases its number, journal `idx` and the `tests/module-migration.test.mjs` "last migration" assertions (§7.3).

### Defaults adopted

The other questions are decided with their recommended defaults. They keep their original numbers, which the sections above cite; questions 1, 3, 5 and 8 are the decisions above.

1. **Module id.** Decided: `finance` (Decisions, item 1). Renaming later would mean changing scopes stored on keys, which is why it was settled before implementation.
2. **`defaultEnabled`.** Default: `true`. Consequence: existing installs get the module on after the deploy, but nothing happens until a mailbox uses `suggest` and the user clicks Track. `false` would need the registry assertion (`tests/module-registry.test.mjs:68`), the Modules page copy and the e2e defaults changed, and most users would never find it.
3. **Migration numbering.** Decided (Decisions, item 7): Money Watch claims 0063 (journal `idx` 66); `mission/attachments-once`, run in parallel, takes 0064 or later; drive storage's planned 0063/0064 move to the next free numbers after both. Whichever of Money Watch and attachments-once merges second rebases its migration file, journal entry and the "last migration" assertions in `tests/module-migration.test.mjs`. The two do not otherwise interact, because Money Watch reads attachments only through `moduleHost.mail.readAttachment` and its ledger has no foreign key to `message_attachments` (§7.2). Consequence: `tests/migration-order.test.mjs` keeps passing; `docs/specs/drive-storage.md` lines 5, 320, 619 and 627 are updated in M4.
4. **Table names.** Default: `finance_subscriptions` and `finance_charges`, not the roadmap's `subscriptions`. Consequence: tables are namespaced like the module and cannot be confused with webhook subscriptions; the roadmap text is updated. The second table is the document ledger (Decisions, item 4) and keeps its name although it also holds credits and refunds: the name is internal and never shown, and `finance_documents` would be a rename with no behaviour change (§7.2).
5. **Model extraction in v1.** Decided: yes (Decisions, item 3), through the generic model extension in §5.7 rather than Money Watch code in core. Consequence: receipt-like bulk and automatic mail the detector cannot complete adds one triage request within the existing caps and the external opt-in (§5.7.5); model values only fill gaps and are validated in code; the cancel link still comes only from the header.
6. **PDF extraction in v1.** Default: yes, best-effort and bounded (§6), in M4. Consequence: invoices whose body only says "your invoice is attached" are found when the PDF has plain text; scanned PDFs and images are not. Dropping it shortens M4 and leaves those to manual add.
7. **Who sees subscriptions.** Default: cards for the reviewer only (C4); rows owner-only everywhere. Consequence: users sharing a mailbox do not see each other's spending; a shared support mailbox's receipts go to its reviewer. The alternative (every full-access user sees the card, the accepter owns the row) contradicts the roadmap's "the owner is the mailbox's reviewer".
8. **Event names.** Decided: `finance.subscription.detected` and `finance.subscription.renewal_due` (Decisions, item 2), prefixed with the module id like `calendar.event.created`. Consequence: they differ from the roadmap's `subscription.detected` and `subscription.renewal.due`, and they are now a public webhook contract. Adding `finance.subscription.updated`, `finance.subscription.cancelled` and `finance.document.recorded` is a cheap follow-up.
9. **Are manual edits, status changes and cancellations audited in `agent_actions`?** Default: yes, all of them (§9.1). Consequence: every change is undoable and listed in Activity, as the roadmap's "every write is audited" asks, at the cost of needing a managed mailbox for the audit row (§9.5). The alternative, `audit_logs` only for manual edits, has no undo.
10. **`mailto:` List-Unsubscribe links.** Default: ignored in v1; only `https` links are stored. Consequence: some vendors show "No cancel link"; a `mailto:` link would open the user's own composer, which is safe but sends mail from their address, so it should be a deliberate later choice (a prefilled draft, never an automatic send).
11. **Server-side RFC 8058 one-click POST.** Default: no; the link only opens in the browser. Consequence: no SSRF surface and no request Kite makes on the user's behalf; the auto-agent spec's line 82 mentions a click-triggered POST, which stays unbuilt. A later change would need an SSRF guard, DKIM coverage of the header and a user click.
12. **Per-mailbox switch for the step.** Default: yes, through the generic `capabilities.modules` map (C8), on by default. Consequence: a user can keep automatic reading for a work mailbox without Money Watch reading it. Without it, the module switch is all-or-nothing per user.
13. **Badge placement.** Default: a new generic `sidebar` placement under For you with a count from `/api/finance/badge` (C12). Consequence: one core change that later modules reuse; the alternative (only the For you count) shows nothing for reminders, which are not suggestions.
14. **Renewal invoices for tracked subscriptions without a click.** Default: no; each renewal invoice is a card ("Netflix renewed, next on 1 Dec. Update it?") until an Act level ships. Consequence: monthly vendors produce a monthly card. A per-row "keep up to date automatically" setting is the follow-up once agent-initiated module actions are allowed.
15. **Failed payment flips to urgent without a click.** Default: no; the card is high priority and accepting marks the row urgent. Consequence: consistent with suggest-only; the roadmap's "flip the item to urgent" needs one click.
16. **Calendar reminders.** Default: on per item (`calendar_reminder` default true) when Calendar is on for the owner, created by the cron at the start of the reminder window, recorded with `moduleHost.audit` rather than `agent_actions`. Consequence: the e2e can check the event; users who dislike them turn them off per item. Auditing them in `agent_actions` would need an agent-initiated action type the executor does not allow at autonomy `suggest`.
17. **Steps-only jobs and the daily limit.** Default: they count toward the per-mailbox daily job limit (default 200). Consequence: a flood of automatic mail cannot run unbounded steps; on a very busy mailbox the limit is reached sooner and later receipts that day are not checked.
18. **Running module steps when the model is refused or fails (C7).** Default: yes, for every module. Consequence: Calendar invites are also detected when the external provider is not allowed, rate limited, over its spend cap or failing on the job's last attempt, which is a visible behaviour change for Calendar and needs a CHANGELOG line.
19. **Assistant write tools and REST scopes.** Default: read-only `list_subscriptions` and `mcp:finance-read` only; no `apiKeyScopes`. Consequence: the assistant can answer "what renews this week" but not change a reminder; writes stay in the UI where undo is shown.
20. **Ambiguous `$`.** Default: USD unless a qualifier or code is on the same line. Consequence: Canadian or Australian vendors that print a bare `$` are stored as USD until the user edits the currency.
21. **Totals across currencies.** Default: one total per currency, no conversion, for both the subscription totals and the 12-month paid total. Consequence: no exchange-rate source or network call; users with mixed currencies see several lines.
22. **Keyword languages.** Default: English, Dutch, German, French and Spanish in `keywords-utils.ts`. Consequence: receipts in other languages are found only through the cycle, renewal and recurring signals; more lists are data-only additions.
23. **Undoing a reminder change after the reminder fired.** §9.1 says undoing "Change reminder" restores the setting and the cron recreates the event if due, but §10.1 skips a row whose `last_reminded_for` already equals the due date, so the calendar event is not recreated. Default: the undo of a reminder change also re-runs the Calendar `upsertReminder` service directly for that row (no second notice, `last_reminded_for` unchanged). Consequence: the event comes back without a duplicate notification; clearing `last_reminded_for` instead would be simpler but sends the notice twice.

### Still open

None.

## 24. Drive filing (follow-up, after Drive ships)

**Not in this mission.** Nothing in this mission calls Drive, imports Drive code, declares a Drive dependency or reads or writes `finance_charges.filed_ref`. [Drive](drive-storage.md) is not built yet and comes after [storing attachments once](attachments-once.md). This section records the agreed behaviour so that the follow-up needs no migration on the ledger and so that the Drive mission knows what to provide.

### 24.1 Behaviour once Drive ships

- **What is filed.** Every ledger row with `attachment_id` and `message_id` set and `filed_ref` null, automatically, for owners for whom both Money Watch and Drive are on. That includes a **backfill** of every row recorded before Drive existed. Rows without an attachment reference are never filed.
- **Where.** The owner's Drive, under `Finance/<vendor>/<year>/`, creating missing folders as the owner. `<vendor>` is the subscription's vendor display name at filing time, sanitised for paths: control, bidirectional and invisible characters removed, `/ \ : * ? " < > |` replaced with `-`, whitespace collapsed, leading and trailing dots and spaces trimmed, cut to 80 characters, and the vendor key when nothing is left. `<year>` is the year of `document_at`. Renaming the vendor later does not move files already filed.
- **File name.** Deterministic: `<YYYY-MM-DD> <vendor> <doc_type> <amount> <currency>.<ext>`, for example `2026-11-01 Netflix invoice 17.99 USD.pdf`, with the document date, the same sanitised vendor, the amount as a plain decimal with the currency's minor digits (no grouping), and the extension of the attachment's own filename (`.pdf` for a PDF without one). A `failed_payment` row without an amount omits the amount and currency. When the name is already taken by another file in that folder, ` (<first 8 characters of the ledger id>)` is appended before the extension, which keeps names deterministic.
- **Copy, never move.** Filing copies the attachment into Drive (counting against the owner's Drive quota, or sharing the stored object if Drive and attachments-once allow it; Drive decides). It never moves, changes or deletes the mail attachment, and deleting or moving the Drive file never touches the mail or the ledger row.
- **Idempotent per ledger row.** `filed_ref` holds the Drive file reference once filed, and a row with `filed_ref` set is never filed again, even if the user deletes the Drive file. The Drive call carries the idempotency key `finance-charge:<ledger id>`, so a retry after a crash between Drive's write and the `filed_ref` update returns the same file instead of a second copy. A permanent skip (the attachment or message is gone, `not_found`) stores `skipped:<code>` so the backfill does not retry it forever; transient failures (quota full, Drive unavailable, timeout) leave `filed_ref` null and are retried.
- **When.** A new ledger row is filed best-effort right after its recording action commits, never inside the action, and a Money Watch cron task (for example `fileDocuments`, on `*/5`, at most 50 rows per tick) does the backfill and the retries. Undoing a recording action deletes the ledger row but leaves the filed Drive copy, which is the user's data; Money Watch never deletes Drive files.
- **Skipped when Drive is off or unavailable.** With Drive off for the install or the owner, or its capability missing or answering `module_disabled`, nothing is filed and the rows stay unfiled until Drive is on again. With Money Watch off nothing is filed either.
- **Access.** The call runs as the owner (viewer = owner, built with `buildCallContext`); Drive itself checks that the owner can still read the attachment with `getAttachmentForUser` and treats a refusal as `not_found`, so filing can never copy a file the owner could not open in the mailbox.
- **How.** Through a Drive `service` capability reached with `moduleHost.invoke(ctx, "drive", "fileAttachment", …)` if Drive becomes a module, or an equivalent host service on `moduleHost` if Drive stays core. That choice belongs to the Drive mission. Money Watch passes only ids and names; bytes never cross the JSON-only invoke boundary.

### 24.2 What the Drive mission must add

1. A `fileAttachment` service (capability or host service): input `{ userId, messageId, attachmentId, folderPath: string[] /* ≤ 4 segments, each ≤ 80 */, fileName /* ≤ 200 */, idempotencyKey /* ≤ 120 */ }`, output `{ fileRef: RecordRef, created: boolean }`, errors `drive_disabled`, `quota_exceeded`, `not_found` and `forbidden`. `userId` must equal `ctx.viewer.userId`. It finds or creates each folder of `folderPath` by name under the owner's root, copies the attachment server-side after the `getAttachmentForUser` check, and is idempotent by `idempotencyKey` per owner (for example a unique source key on `drive_items`).
2. A record kind for Drive files (for example `drive:file`) with a resolver, so the Money Watch drawer can show "In Drive" with a link, unavailable when the file is gone or Drive is off.
3. A way for another module to ask whether Drive is on for a user (`moduleHost.modules.isEnabledFor(ctx, user, "drive")` if Drive is a module).
4. Its own path rules, if stricter than §24.1; the service then returns the final path and name, and Money Watch stores only the returned reference.

The Money Watch side of the follow-up is then small: the filing call after recording actions, the cron task in the manifest, the drawer link, `filed_ref` reads and writes, unit tests for the path and name rules, and an e2e case that turns Drive on and sees earlier documents filed under `Finance/<vendor>/<year>/`. The ledger is small (one row per document), so the backfill scans by `finance_charges_user_idx` and needs no new index.
