import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { financeSubscriptions as subscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { onFinanceTables } from "./errors";
import type { SubscriptionRow } from "./record-utils";
import { selectionBounds } from "./reminder-utils";

const db = () => getDb(getEnv());

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const dueColumn = sql`(CASE WHEN ${subscriptions.status} = 'trial' AND ${subscriptions.trialEndsAt} IS NOT NULL THEN ${subscriptions.trialEndsAt} ELSE ${subscriptions.nextRenewalAt} END)`;

export type DueCursor = { dueAt: Date; id: string };

/**
 * Active and trial rows with reminders on whose due date is near and not yet reminded, earliest
 * first. Page by due date and id, since claiming a reminder removes it from this selection.
 */
export function dueRows(now: Date, limit: number, after?: DueCursor): Promise<SubscriptionRow[]> {
	const { from, until } = selectionBounds(now);
	return onFinanceTables(() =>
		db()
			.select()
			.from(subscriptions)
			.where(
				and(
					inArray(subscriptions.status, ["active", "trial"]),
					gt(subscriptions.reminderDays, 0),
					sql`${dueColumn} >= ${seconds(from)}`,
					sql`${dueColumn} <= ${seconds(until)} + ${subscriptions.reminderDays} * 86400`,
					sql`(${subscriptions.lastRemindedFor} IS NULL OR ${subscriptions.lastRemindedFor} <> ${dueColumn})`,
					after
						? or(
								sql`${dueColumn} > ${seconds(after.dueAt)}`,
								and(sql`${dueColumn} = ${seconds(after.dueAt)}`, gt(subscriptions.id, after.id)),
							)
						: undefined,
				),
			)
			.orderBy(dueColumn, subscriptions.id)
			.limit(limit),
	);
}

/** Marks the row reminded for `dueAt`; true only for the one call that changed it, so overlapping ticks remind once. */
export async function claimReminder(id: string, dueAt: Date): Promise<boolean> {
	const claimed = await onFinanceTables(() =>
		db()
			.update(subscriptions)
			.set({ lastRemindedFor: dueAt })
			.where(
				and(
					eq(subscriptions.id, id),
					or(isNull(subscriptions.lastRemindedFor), ne(subscriptions.lastRemindedFor, dueAt)),
				),
			)
			.returning({ id: subscriptions.id }),
	);
	return claimed.length > 0;
}

/** Records the row's reminder event; bookkeeping, so `updated_at` stays as the user left it. */
export async function setCalendarEvent(userId: string, id: string, eventId: string | null): Promise<void> {
	await onFinanceTables(() =>
		db()
			.update(subscriptions)
			.set({ calendarEventId: eventId })
			.where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId))),
	);
}

export type ReminderOwner = { userId: string; role: string; isPrimaryAdmin: boolean; timeZone: string | null };

/** The owner as a call context needs them: role for the module checks and the time zone of their calendar day. */
export async function reminderOwner(userId: string): Promise<ReminderOwner | null> {
	const [owner] = await db()
		.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin, timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return owner ? { userId, ...owner, isPrimaryAdmin: owner.role === "admin" && owner.isPrimaryAdmin } : null;
}
