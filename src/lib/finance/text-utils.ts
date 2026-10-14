import { formatMoney } from "./amount-utils";
import type { Cycle, SubscriptionPayload } from "./types";

const MAX_TITLE = 120;

const CYCLE_UNITS: Record<Cycle, string> = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "1 Nov" for `2026-11-01`.
 * @public Exercised by the bundled unit tests.
 */
export function shortDay(day: string): string {
	return SHORT_DAY.format(new Date(`${day}T00:00:00Z`));
}

type Money = Pick<SubscriptionPayload, "amountMinor" | "currency">;

function money(payload: Money, locale: string): string | null {
	return payload.amountMinor !== null && payload.currency
		? formatMoney(payload.amountMinor, payload.currency, locale)
		: null;
}

/** "$17.99/month", "$17.99" without a cycle, null without an amount. */
export function priceText(payload: Money & Pick<SubscriptionPayload, "cycle">, locale: string): string | null {
	const amount = money(payload, locale);
	if (!amount) return null;
	return payload.cycle ? `${amount}/${CYCLE_UNITS[payload.cycle]}` : amount;
}

function joined(parts: (string | null | false)[]): string {
	return parts.filter(Boolean).join("");
}

function newTitle(payload: SubscriptionPayload, locale: string): string {
	const price = priceText(payload, locale);
	return joined([
		payload.vendor,
		price && ` ${price}`,
		payload.nextRenewalOn && `, renews ${shortDay(payload.nextRenewalOn)}`,
		". Track it?",
	]);
}

function priceChangeTitle(payload: SubscriptionPayload, locale: string): string {
	const previous = money({ amountMinor: payload.previousAmountMinor, currency: payload.currency }, locale);
	const direction =
		payload.previousAmountMinor !== null &&
		payload.amountMinor !== null &&
		payload.amountMinor < payload.previousAmountMinor
			? "down"
			: "up";
	return joined([
		payload.vendor,
		` now ${priceText(payload, locale) ?? ""}`,
		previous && `, ${direction} from ${previous}`,
		". Update it?",
	]);
}

function refundTitle(payload: SubscriptionPayload, locale: string): string {
	const amount = money(payload, locale) ?? "";
	return payload.document?.docType === "credit"
		? `${payload.vendor} credit note for ${amount}. Record it?`
		: `${payload.vendor} refunded ${amount}. Record it?`;
}

/** The card title for a detection (spec §5.8), at most 120 characters. */
export function suggestionTitle(payload: SubscriptionPayload, locale: string): string {
	const titles: Record<SubscriptionPayload["event"], () => string> = {
		new: () => newTitle(payload, locale),
		trial: () =>
			payload.trialEndsOn
				? `${payload.vendor} trial ends ${shortDay(payload.trialEndsOn)}. Track it?`
				: `${payload.vendor} trial. Track it?`,
		renewal: () =>
			joined([
				payload.vendor,
				" renewed",
				payload.nextRenewalOn && `, next on ${shortDay(payload.nextRenewalOn)}`,
				". Update it?",
			]),
		price_change: () => priceChangeTitle(payload, locale),
		payment_failed: () => `${payload.vendor} payment failed. Mark it urgent?`,
		refund: () => refundTitle(payload, locale),
	};
	const title = titles[payload.event]();
	return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`;
}

const DOCUMENT_WORDS = { invoice: "invoice", payment: "payment", credit: "credit note", refund: "refund" } as const;

/** "Records this invoice of $17.99, 1 Nov": what accepting also records, for new, renewal and price change cards. */
export function documentLine(payload: SubscriptionPayload, locale: string): string | null {
	const document = payload.document;
	if (!document || document.docType === "failed_payment") return null;
	if (!["new", "renewal", "price_change"].includes(payload.event)) return null;
	const amount = money(payload, locale);
	return joined([
		`Records this ${DOCUMENT_WORDS[document.docType]}`,
		amount && ` of ${amount}`,
		`, ${shortDay(document.documentOn)}`,
	]);
}

/** The host the cancel link opens, shown before anyone clicks it; "No cancel link" without one. */
export function cancelLinkLine(payload: Pick<SubscriptionPayload, "cancelLink">): string {
	if (!payload.cancelLink) return "No cancel link";
	try {
		return `Cancel link: ${new URL(payload.cancelLink.url).hostname}`;
	} catch {
		return "No cancel link";
	}
}
