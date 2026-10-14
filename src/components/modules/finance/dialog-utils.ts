import { formatDecimal, minorDigits } from "@/lib/finance/amount-utils";
import type { DocumentDraft, ManualDraft } from "@/lib/finance/manual-utils";
import type { DocumentForm, TrackForm } from "./dialog-types";

export const DOCUMENT_TYPES = [
	{ value: "invoice", label: "Invoice" },
	{ value: "payment", label: "Payment" },
	{ value: "credit", label: "Credit note" },
	{ value: "refund", label: "Refund" },
] as const;

export const CYCLES = [
	{ value: "", label: "Unknown" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
	{ value: "quarterly", label: "Quarterly" },
	{ value: "yearly", label: "Yearly" },
] as const;

/**
 * Minor units for an amount typed as "17.99" or "17,99" in the currency's minor digits, or null when it
 * is not a plain positive amount. Thousands separators are not accepted, so "1,000" is never read as 1.
 * @public Exercised by the bundled unit tests.
 */
export function parseAmountInput(text: string, currency: string): number | null {
	const digits = minorDigits(currency.trim().toUpperCase());
	const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim());
	if (!match) return null;
	const fraction = match[2] ?? "";
	if (fraction.length > digits) return null;
	const value = Number(match[1] + fraction.padEnd(digits, "0"));
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const amountText = (minor: number | null, currency: string | null) =>
	minor !== null && currency ? formatDecimal(minor, currency) : "";

export function trackForm(draft: ManualDraft | null): TrackForm {
	return {
		vendor: draft?.vendor ?? "",
		plan: draft?.plan ?? "",
		amount: amountText(draft?.amountMinor ?? null, draft?.currency ?? null),
		currency: draft?.currency ?? "",
		cycle: draft?.cycle ?? "",
		nextRenewalOn: draft?.nextRenewalOn ?? "",
		trialEndsOn: draft?.trialEndsOn ?? "",
		reminderDays: "3",
		calendarReminder: true,
	};
}

export function documentForm(draft: DocumentDraft | null, today: string): DocumentForm {
	return {
		docType: draft?.docType ?? "payment",
		amount: amountText(draft?.amountMinor ?? null, draft?.currency ?? null),
		currency: draft?.currency ?? "",
		documentOn: draft?.documentOn ?? today,
		periodStartOn: draft?.periodStartOn ?? "",
		periodEndOn: draft?.periodEndOn ?? "",
		attachmentId: draft?.attachmentId ?? "",
	};
}

type Built<T> = { body: T } | { error: string };

/** The document part of a request body, or the first problem to show. */
export function documentBody(form: DocumentForm): Built<Record<string, unknown>> {
	const currency = form.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return { error: "Enter a three-letter currency code, like EUR" };
	const amountMinor = parseAmountInput(form.amount, currency);
	if (amountMinor === null) return { error: "Enter the document's amount, like 17.99" };
	if (!form.documentOn) return { error: "Enter the document date" };
	if (!form.periodStartOn !== !form.periodEndOn) return { error: "A period needs both a start and an end" };
	return {
		body: {
			docType: form.docType,
			amountMinor,
			currency,
			documentOn: form.documentOn,
			periodStartOn: form.periodStartOn || null,
			periodEndOn: form.periodEndOn || null,
			attachmentId: form.attachmentId || null,
		},
	};
}

/** The `POST /api/finance/subscriptions` body of "Track as subscription", or the first problem to show. */
export function trackBody(
	form: TrackForm,
	messageId: string,
	document: DocumentForm | null,
): Built<Record<string, unknown>> {
	if (!form.vendor.trim()) return { error: "Enter the vendor" };
	const currency = form.currency.trim().toUpperCase();
	let amountMinor: number | null = null;
	if (form.amount.trim()) {
		if (!/^[A-Z]{3}$/.test(currency)) return { error: "Enter a three-letter currency code, like EUR" };
		amountMinor = parseAmountInput(form.amount, currency);
		if (amountMinor === null) return { error: "Enter the amount, like 17.99" };
	}
	const reminderDays = Number(form.reminderDays);
	if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 30)
		return { error: "Remind between 0 and 30 days before" };
	const recorded = document ? documentBody(document) : null;
	if (recorded && "error" in recorded) return recorded;
	return {
		body: {
			vendor: form.vendor.trim(),
			plan: form.plan.trim() || null,
			amountMinor,
			currency: amountMinor === null ? null : currency,
			cycle: form.cycle || null,
			nextRenewalOn: form.nextRenewalOn || null,
			trialEndsOn: form.trialEndsOn || null,
			reminderDays,
			calendarReminder: form.calendarReminder,
			messageId,
			document: recorded?.body ?? null,
		},
	};
}

/** "streamflix.example" for a cancel link, so the dialog names where it leads without making it clickable. */
export function linkHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
