import { daysBetween } from "./date-utils";
import type { SubscriptionStatus } from "./types";

export type DueRow = {
	status: SubscriptionStatus;
	nextRenewalAt: Date | null;
	trialEndsAt: Date | null;
	paymentFailedAt: Date | null;
	reminderDays: number;
};

/**
 * The day a reminder is about: the trial end for a trial that has one, otherwise the next renewal.
 * @public Test-only: used inside this file, exported for tests.
 */
export function dueDay(row: Pick<DueRow, "status" | "nextRenewalAt" | "trialEndsAt">): string | null {
	const due = row.status === "trial" && row.trialEndsAt ? row.trialEndsAt : row.nextRenewalAt;
	return due ? due.toISOString().slice(0, 10) : null;
}

function needsAttention(row: DueRow, today: string): boolean {
	if (row.status !== "active" && row.status !== "trial") return false;
	if (row.paymentFailedAt) return true;
	const due = dueDay(row);
	if (!due || row.reminderDays <= 0) return false;
	const daysLeft = daysBetween(today, due);
	return daysLeft >= 0 && daysLeft <= row.reminderDays;
}

/**
 * The sidebar count: active and trial rows due today or later within their reminder window or whose
 * payment failed, as the page's "Needs attention" section has them. `today` is the owner's calendar day.
 */
export function badgeCount(rows: readonly DueRow[], today: string): number {
	return rows.filter((row) => needsAttention(row, today)).length;
}
