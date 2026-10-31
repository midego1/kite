import type { SubscriptionItem } from "@/components/finance/subscriptions-types";
import { dueDayOf, priceLabel } from "@/components/finance/subscriptions-utils";
import { daysBetween } from "@/lib/finance/date-utils";
import { shortDay } from "@/lib/finance/text-utils";
import type { RenewalLines } from "./renewals-card-types";

/**
 * The subscriptions the Money Watch card lists, at most.
 * @public Test-only: used inside this file, exported for tests.
 */
export const RENEWALS_MAX_LINES = 4;
/** How many days the card looks ahead, today included. */
const RENEWALS_WINDOW_DAYS = 7;

const isCurrent = (item: SubscriptionItem) => item.status === "active" || item.status === "trial";

function dayWord(due: string, today: string): string {
	const days = daysBetween(today, due);
	if (days === 0) return "Today";
	return days === 1 ? "Tomorrow" : shortDay(due);
}

/**
 * What is due this week, as the Money Watch card lists it: failed payments first, then current
 * subscriptions renewing or ending their trial from `today` (the viewer's day) through the next six days,
 * earliest first.
 */
export function renewalLines(items: readonly SubscriptionItem[], today: string, locale: string): RenewalLines {
	const failed = items.filter((item) => item.status === "active" && item.urgent);
	const due = items
		.filter((item) => isCurrent(item) && !item.urgent)
		.flatMap((item) => {
			const day = dueDayOf(item);
			if (!day) return [];
			const days = daysBetween(today, day);
			return days >= 0 && days < RENEWALS_WINDOW_DAYS ? [{ item, day }] : [];
		})
		.sort((a, b) => a.day.localeCompare(b.day) || a.item.vendor.localeCompare(b.item.vendor));
	const all = [
		...failed.map((item) => ({ id: item.id, when: "Failed", what: item.vendor, meta: "Payment failed", urgent: true })),
		...due.map(({ item, day }) => ({
			id: item.id,
			when: dayWord(day, today),
			what: item.vendor,
			meta: item.status === "trial" && item.trialEndsOn ? "Trial ends" : priceLabel(item, locale),
			urgent: false,
		})),
	];
	return {
		lines: all
			.slice(0, RENEWALS_MAX_LINES)
			.map((line) => ({ ...line, href: `/finance?subscription=${encodeURIComponent(line.id)}` })),
		more: Math.max(0, all.length - RENEWALS_MAX_LINES),
	};
}
