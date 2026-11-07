import { formatDecimal, isCurrencyCode, MAX_AMOUNT_MINOR, minorDigits } from "./amount-utils";
import type { ChatTrackInput } from "./chat-track-schema";
import type { ManualDraft } from "./manual-utils";
import { priceText } from "./text-utils";
import type { Cycle, SubscriptionStatus } from "./types";

/** The proposal the approval card shows and the tool runs: every field explicit, null when nobody stated it. */
export type ChatTrackProposal = {
	emailId?: string;
	mode: "track" | "attach";
	subscriptionId: string | null;
	vendor: string | null;
	plan: string | null;
	amount: string | null;
	currency: string | null;
	cycle: Cycle | null;
	nextRenewalOn: string | null;
	docType: "invoice" | "payment" | "credit" | "refund" | null;
	documentOn: string | null;
	attachmentId: string | null;
};

/** A tracked subscription the proposal would add the receipt to instead of tracking it twice. */
export type ChatTrackExisting = {
	id: string;
	vendor: string;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
};

/** What the card shows besides the fields: which values the assistant supplied, and the tracked row, if any. */
export type ChatTrackDetails = {
	/** Fields the assistant filled in because the email did not state them (or there was no email). */
	assisted: string[];
	/** The renewal was worked out from the billing period and the receipt's date, not read. */
	renewalEstimated: boolean;
	existing: ChatTrackExisting | null;
	attachmentName: string | null;
	/** The host of the cancel link saving takes from the email's own `List-Unsubscribe`, so the card shows it. */
	cancelLinkHost?: string | null;
	/** The email the card reads, so the user sees which one the assistant picked; null without one. */
	email?: { subject: string | null; from: string } | null;
};

const MERGED_FIELDS = ["vendor", "plan", "amount", "currency", "cycle", "nextRenewalOn"] as const;
type MergedField = (typeof MERGED_FIELDS)[number];

function draftValues(draft: ManualDraft | null): Record<MergedField, string | null> {
	const amount = draft?.amountMinor != null && draft.currency ? formatDecimal(draft.amountMinor, draft.currency) : null;
	return {
		vendor: draft?.vendor || null,
		plan: draft?.plan ?? null,
		amount,
		currency: amount ? draft!.currency : null,
		cycle: draft?.cycle ?? null,
		nextRenewalOn: draft?.nextRenewalOn ?? null,
	};
}

/** The read values with the assistant's input in the fields Kite left empty, and which fields those are. */
function fillFromAssistant(read: Record<MergedField, string | null>, model: ChatTrackInput) {
	const values = { ...read };
	const assisted: string[] = [];
	for (const field of MERGED_FIELDS) {
		const given = model[field];
		if (values[field] !== null || field === "currency" || !given) continue;
		values[field] = given;
		assisted.push(field);
		if (field === "amount" && model.currency) {
			values.currency = model.currency;
			assisted.push("currency");
		}
	}
	if (values.amount === null) values.currency = null;
	return { values, assisted };
}

function documentFields(draft: ManualDraft | null) {
	const document = draft?.document ?? null;
	return {
		docType: document?.docType ?? null,
		documentOn: document?.documentOn ?? null,
		attachmentId: document?.attachmentId ?? null,
	};
}

/**
 * The card's fields: what Kite read from the email first, and only the fields it left empty from the assistant's
 * input, so a message that talks the model into other values cannot override what the email states (the same rule
 * as automatic reading). Nothing is guessed: a field neither states stays null and the card asks for it. An amount
 * from the assistant comes with its own currency only, never paired with one Kite read for another amount.
 */
export function mergeProposal(
	draft: ManualDraft | null,
	model: ChatTrackInput,
	existing: ChatTrackExisting | null,
	attachmentName: string | null,
): { proposal: ChatTrackProposal; details: ChatTrackDetails } {
	const read = draftValues(draft);
	const { values, assisted } = fillFromAssistant(read, model);
	return {
		proposal: {
			...(model.emailId ? { emailId: model.emailId } : {}),
			mode: existing ? "attach" : "track",
			subscriptionId: existing?.id ?? null,
			vendor: existing ? existing.vendor : values.vendor,
			plan: values.plan,
			amount: values.amount,
			currency: values.currency,
			cycle: values.cycle as Cycle | null,
			nextRenewalOn: values.nextRenewalOn,
			...documentFields(draft),
		},
		details: {
			assisted,
			renewalEstimated: !!draft?.renewalEstimated && read.nextRenewalOn !== null,
			existing,
			attachmentName,
		},
	};
}

/**
 * A decimal amount in minor units of its currency, or null when it has more decimals than the currency or is out of range.
 * @public Exercised by the bundled unit tests.
 */
export function decimalToMinor(amount: string, currency: string): number | null {
	const match = /^(\d{1,9})(?:[.,](\d{1,3}))?$/.exec(amount.trim());
	if (!match) return null;
	const digits = minorDigits(currency);
	const fraction = match[2] ?? "";
	if (fraction.length > digits) return null;
	const minor = Number(match[1] + fraction.padEnd(digits, "0"));
	return Number.isSafeInteger(minor) && minor >= 1 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

type Money = { amountMinor: number; currency: string };

/**
 * The amount and currency together, none when the amount is blank, or why they cannot be saved.
 * @public Exercised by the bundled unit tests.
 */
export function moneyOf(input: Pick<ChatTrackProposal, "amount" | "currency">): Money | null | { error: string } {
	if (!input.amount) return null;
	const currency = input.currency?.toUpperCase() ?? "";
	if (!currency) return { error: "An amount needs a currency" };
	if (!isCurrencyCode(currency)) return { error: "Use an ISO 4217 currency code such as EUR" };
	const amountMinor = decimalToMinor(input.amount, currency);
	if (amountMinor === null)
		return { error: `Write the amount as a decimal with at most ${minorDigits(currency)} decimals` };
	return { amountMinor, currency };
}

/** The body `addSubscription` takes for a proposal in `track` mode, or why it cannot be saved. */
export function trackRequestBody(
	input: ChatTrackProposal,
	context: { mailboxId: string },
): { body: Record<string, unknown> } | { error: string } {
	const vendor = input.vendor?.trim();
	if (!vendor) return { error: "Name the service to track" };
	const money = moneyOf(input);
	if (money && "error" in money) return money;
	const body: Record<string, unknown> = {
		vendor,
		plan: input.plan?.trim() || null,
		amountMinor: money?.amountMinor ?? null,
		currency: money?.currency ?? null,
		cycle: input.cycle,
		nextRenewalOn: input.nextRenewalOn,
	};
	if (!input.emailId) return { body: { ...body, mailboxId: context.mailboxId } };
	body.messageId = input.emailId;
	if (!input.docType) return { body };
	// The email is recorded as the subscription's first document with the amount and date the card showed; nothing
	// is filled in on approval that the user did not see.
	if (!money) return { error: "A document needs its amount" };
	if (!input.documentOn) return { error: "A document needs its date" };
	body.document = {
		docType: input.docType,
		amountMinor: money.amountMinor,
		currency: money.currency,
		documentOn: input.documentOn,
		attachmentId: input.attachmentId,
	};
	return { body };
}

/** The body `addDocument` takes for a proposal in `attach` mode, or why it cannot be saved. */
export function attachRequestBody(
	input: ChatTrackProposal,
): { subscriptionId: string; body: Record<string, unknown> } | { error: string } {
	if (!input.subscriptionId) return { error: "The tracked subscription is missing" };
	if (!input.emailId) return { error: "Only an email can be added to a tracked subscription" };
	if (!input.docType) return { error: "Choose what the email is: an invoice, payment, credit note or refund" };
	const money = moneyOf(input);
	if (!money) return { error: "A document needs its amount" };
	if ("error" in money) return money;
	if (!input.documentOn) return { error: "A document needs its date" };
	return {
		subscriptionId: input.subscriptionId,
		body: {
			messageId: input.emailId,
			docType: input.docType,
			amountMinor: money.amountMinor,
			currency: money.currency,
			documentOn: input.documentOn,
			attachmentId: input.attachmentId,
		},
	};
}

/**
 * A name compared without case, accents, spaces or punctuation: "Net-flix" and "netflix" are the same service.
 * @public Exercised by the bundled unit tests.
 */
export function serviceNameKey(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

type ExistingRow = ChatTrackExisting & { vendorKey: string; status: SubscriptionStatus };

const CURRENT: readonly SubscriptionStatus[] = ["active", "trial"];

/**
 * The owner's tracked subscription for the same service, so the proposal adds the receipt to it instead of tracking
 * it twice: the row with one of `vendorKeys` (the email's sender, or the name typed by hand), else the row whose name
 * reads the same. A current row wins over a cancelled or expired one, then the one with the same plan.
 */
export function findExisting(
	rows: readonly ExistingRow[],
	query: { vendorKeys: readonly string[]; vendor: string | null; plan: string | null },
): ChatTrackExisting | null {
	const name = query.vendor ? serviceNameKey(query.vendor) : "";
	const byKey = rows.filter((row) => query.vendorKeys.includes(row.vendorKey));
	const candidates = byKey.length ? byKey : name ? rows.filter((row) => serviceNameKey(row.vendor) === name) : [];
	const plan = query.plan?.toLowerCase() ?? null;
	const score = (row: ExistingRow) =>
		(CURRENT.includes(row.status) ? 2 : 0) + (plan && row.plan?.toLowerCase() === plan ? 1 : 0);
	const [best] = [...candidates].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
	if (!best) return null;
	return {
		id: best.id,
		vendor: best.vendor,
		plan: best.plan,
		amountMinor: best.amountMinor,
		currency: best.currency,
		cycle: best.cycle,
	};
}

const NOT_STATED = "not stated";

/**
 * The card's lines, in English for the assistant and for a chat without the module's card: what would be tracked, or
 * which tracked subscription the email would be added to. Blank fields say so, so the assistant asks for them.
 */
export function proposalItems(proposal: ChatTrackProposal, details: ChatTrackDetails, locale: string) {
	const money = moneyOf(proposal);
	const amount = money && !("error" in money) ? `${proposal.amount} ${money.currency}` : NOT_STATED;
	if (proposal.mode === "attach" && details.existing) {
		const tracked = priceText(details.existing, locale);
		return [
			{
				label: `Add this email to ${details.existing.vendor}${tracked ? ` (${tracked})` : ""}`,
				detail: `Already tracked, so it is not added twice. Document: ${proposal.docType ?? NOT_STATED}, amount ${amount}, date ${proposal.documentOn ?? NOT_STATED}`,
			},
		];
	}
	return [
		{
			label: `Track ${proposal.vendor ?? "a subscription"}`,
			detail: [
				`Amount ${amount}`,
				`billing period ${proposal.cycle ?? NOT_STATED}`,
				`next renewal ${proposal.nextRenewalOn ?? NOT_STATED}${details.renewalEstimated ? " (estimated)" : ""}`,
				...(proposal.plan ? [`plan ${proposal.plan}`] : []),
			].join(", "),
		},
	];
}
