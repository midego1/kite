import { msg, t } from "@/lib/i18n/translator";
import type { MessageKey } from "@/lib/i18n/i18n-types";

/** The card's view of a `track_subscription` input: every field a string or null, as the server stored it. */
export type TrackProposalFields = {
	mode: "track" | "attach";
	emailId: string | null;
	vendor: string | null;
	plan: string | null;
	amount: string | null;
	currency: string | null;
	cycle: string | null;
	nextRenewalOn: string | null;
	docType: string | null;
	documentOn: string | null;
	attachmentId: string | null;
	subscriptionId: string | null;
};

/** The preview's `details`: which values the assistant supplied, and the subscription the email would be added to. */
export type TrackProposalDetails = {
	assisted: string[];
	renewalEstimated: boolean;
	existing: { vendor: string } | null;
	attachmentName: string | null;
	/** The host of the cancel link saving takes from the email's `List-Unsubscribe`. */
	cancelLinkHost: string | null;
	/** The email the card reads, so the user sees which one the assistant picked. */
	email: { subject: string | null; from: string | null } | null;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export function proposalFields(input: Record<string, unknown>): TrackProposalFields {
	return {
		mode: input.mode === "attach" ? "attach" : "track",
		emailId: text(input.emailId),
		vendor: text(input.vendor),
		plan: text(input.plan),
		amount: text(input.amount),
		currency: text(input.currency),
		cycle: text(input.cycle),
		nextRenewalOn: text(input.nextRenewalOn),
		docType: text(input.docType),
		documentOn: text(input.documentOn),
		attachmentId: text(input.attachmentId),
		subscriptionId: text(input.subscriptionId),
	};
}

export function proposalDetails(details: Record<string, unknown>): TrackProposalDetails {
	const existing = details.existing as { vendor?: unknown } | null | undefined;
	const email = details.email as { subject?: unknown; from?: unknown } | null | undefined;
	return {
		assisted: Array.isArray(details.assisted)
			? details.assisted.filter((item): item is string => typeof item === "string")
			: [],
		renewalEstimated: details.renewalEstimated === true,
		existing: existing && typeof existing.vendor === "string" ? { vendor: existing.vendor } : null,
		attachmentName: text(details.attachmentName),
		cancelLinkHost: text(details.cancelLinkHost),
		email: email ? { subject: text(email.subject), from: text(email.from) } : null,
	};
}

/** A field as the card sends it: a blank field is null, so it stays empty instead of keeping the proposed value. */
function editValue(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? value : null;
}

/**
 * The card's edits after the user changed one field. A renewal Kite estimated from the billing period no longer holds
 * once the period changes, so it is cleared (and its "estimated" note goes) unless the user set the date themselves;
 * the card asks for it rather than guessing again.
 */
export function withEdit(
	edits: Record<string, unknown>,
	key: string,
	value: string,
	renewalEstimated: boolean,
): Record<string, unknown> {
	const next = { ...edits, [key]: editValue(value) };
	if (key === "cycle" && renewalEstimated && !Object.hasOwn(edits, "nextRenewalOn")) next.nextRenewalOn = null;
	return next;
}

/** Whether the next renewal still shows the date Kite estimated: it was estimated, and nobody changed it since. */
export function showsEstimatedRenewal(
	fields: Pick<TrackProposalFields, "nextRenewalOn">,
	details: Pick<TrackProposalDetails, "renewalEstimated">,
	edits: Record<string, unknown>,
): boolean {
	return details.renewalEstimated && !!fields.nextRenewalOn && !Object.hasOwn(edits, "nextRenewalOn");
}

export const CYCLE_OPTIONS: { value: string; label: MessageKey }[] = [
	{ value: "weekly", label: msg("Weekly") },
	{ value: "monthly", label: msg("Monthly") },
	{ value: "quarterly", label: msg("Quarterly") },
	{ value: "yearly", label: msg("Yearly") },
];

export const DOC_TYPE_OPTIONS: { value: string; label: MessageKey }[] = [
	{ value: "invoice", label: msg("Invoice") },
	{ value: "payment", label: msg("Payment") },
	{ value: "credit", label: msg("Credit note") },
	{ value: "refund", label: msg("Refund") },
];

const AMOUNT = /^\d{1,9}(?:[.,]\d{1,3})?$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** Why the amount and currency cannot be saved as they are, or null. The server checks the currency list itself. */
function moneyProblem(fields: TrackProposalFields, required: boolean): string | null {
	if (!fields.amount) return required ? t("Add the amount") : null;
	if (!AMOUNT.test(fields.amount.trim())) return t("Write the amount as a number such as 17.99");
	if (!fields.currency || !CURRENCY.test(fields.currency.trim())) return t("Add a currency code such as EUR");
	return null;
}

/** The approve button's text and why it is not available yet; Kite asks rather than guessing a missing value. */
export function approveState(fields: TrackProposalFields): { label: string; blocked: string | null } {
	const documentProblem = () => moneyProblem(fields, true) ?? (fields.documentOn ? null : t("Add the document date"));
	if (fields.mode === "attach") {
		const vendor = fields.vendor ?? "";
		return {
			label: t("Add to {vendor}", { vendor }),
			blocked: fields.docType ? documentProblem() : t("Choose what this email is"),
		};
	}
	const recordsEmail = !!fields.emailId && !!fields.docType;
	return {
		label: t("Track subscription"),
		blocked: !fields.vendor
			? t("Name the service first")
			: recordsEmail
				? documentProblem()
				: moneyProblem(fields, false),
	};
}

/** What the approved card did, next to Undo. */
export function approvedText(fields: TrackProposalFields): string {
	const vendor = fields.vendor ?? "";
	return fields.mode === "attach" ? t("Added to {vendor}.", { vendor }) : t("Tracking {vendor}.", { vendor });
}
