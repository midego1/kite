import { dateToDay, type SubscriptionRow } from "./record-utils";
import { shortDay } from "./text-utils";

/** A `LIKE … ESCAPE '\'` pattern matching `query` anywhere, with `%`, `_` and `\` taken literally. */
export function containsPattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

type SublabelRow = Pick<SubscriptionRow, "plan" | "status" | "nextRenewalAt" | "trialEndsAt" | "paymentFailedAt">;

const STATUS_TEXT: Record<SubscriptionRow["status"], string> = {
	active: "Active",
	trial: "Trial",
	cancelled: "Cancelled",
	expired: "Expired",
};

function dueText(row: SublabelRow): string {
	const trialEnd = row.status === "trial" ? dateToDay(row.trialEndsAt) : null;
	if (trialEnd) return `Trial ends ${shortDay(trialEnd)}`;
	const renewal = row.status === "active" || row.status === "trial" ? dateToDay(row.nextRenewalAt) : null;
	return renewal ? `Renews ${shortDay(renewal)}` : STATUS_TEXT[row.status];
}

/** The search row's second line: "Family · Renews 1 Nov", "Trial ends 20 Oct" or "Cancelled". */
export function searchSublabel(row: SublabelRow): string {
	const urgent = row.status === "active" && row.paymentFailedAt ? "Payment failed" : null;
	return [row.plan, urgent, dueText(row)].filter(Boolean).join(" · ");
}
