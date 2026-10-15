import { createLogger } from "@/lib/logger.mjs";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { calendarSync, dueOf, reminderEvent, reminderKey, type Due, type ReminderRow } from "./reminder-utils";
import { setCalendarEvent } from "./reminder-store";
import { ownerRow } from "./subscriptions";

const log = createLogger("finance");

/** Logs a reminder step that failed with only the subscription id and a code: no vendor, amount, date or URL. */
export function reminderFailed(subscriptionId: string, code: string): void {
	log.warn("finance.reminder_failed", { subscriptionId, code });
}

type ServiceOutput = { eventId?: string; created?: boolean; removed?: boolean; refused?: string };

async function callCalendar(
	ctx: CapabilityCallContext,
	subscriptionId: string,
	name: "upsertReminder" | "removeReminder",
	input: Record<string, JsonValue>,
): Promise<ServiceOutput | null> {
	try {
		const result = await moduleHost.invoke(ctx, "calendar", name, input);
		if (!result.ok) {
			reminderFailed(subscriptionId, `calendar_${result.error.code}`);
			return null;
		}
		const output = result.output as ServiceOutput;
		if (output.refused) {
			reminderFailed(subscriptionId, `calendar_${output.refused}`);
			return null;
		}
		return output;
	} catch {
		reminderFailed(subscriptionId, "calendar_failed");
		return null;
	}
}

/** Adds or moves the row's reminder event on the owner's calendar and records it; failures are only logged. */
export async function upsertCalendarReminder(
	ctx: CapabilityCallContext,
	userId: string,
	row: ReminderRow,
	due: Due,
	timeZone: string,
): Promise<void> {
	const output = await callCalendar(ctx, row.id, "upsertReminder", { userId, ...reminderEvent(row, due, timeZone) });
	if (!output?.eventId) return;
	try {
		if (row.calendarEventId !== output.eventId) await setCalendarEvent(userId, row.id, output.eventId);
		await moduleHost.audit(ctx, "finance.calendar_reminder", {
			subscriptionId: row.id,
			eventId: output.eventId,
			created: output.created === true,
		});
	} catch {
		reminderFailed(row.id, "calendar_bookkeeping_failed");
	}
}

async function removeCalendarReminder(ctx: CapabilityCallContext, userId: string, row: ReminderRow | null, id: string) {
	const output = await callCalendar(ctx, id, "removeReminder", { userId, key: reminderKey(id) });
	if (!output?.removed) return;
	try {
		if (row?.calendarEventId) await setCalendarEvent(userId, id, null);
		await moduleHost.audit(ctx, "finance.calendar_reminder_removed", { subscriptionId: id });
	} catch {
		reminderFailed(id, "calendar_bookkeeping_failed");
	}
}

/**
 * Keeps the row's calendar event in step after a user's change or its undo (spec §11, §23 q23): removed
 * when the row is gone or can no longer remind, moved or put back when it exists, already fired for
 * this due date or `restore` says the undone change took one away. Nothing happens while Calendar is
 * off for the owner, so existing events stay.
 */
export async function syncCalendarReminder(
	ctx: CapabilityCallContext,
	userId: string,
	subscriptionId: string,
	options: { restore?: boolean } = {},
): Promise<void> {
	try {
		if (!(await moduleHost.modules.isEnabledFor(ctx, userId, "calendar"))) return;
		const row = await ownerRow(userId, subscriptionId);
		const plan = calendarSync(row, options);
		if (plan === "remove") return await removeCalendarReminder(ctx, userId, row, subscriptionId);
		const due = row && dueOf(row);
		if (plan !== "upsert" || !row || !due) return;
		const profile = await moduleHost.users.getProfile(ctx, userId);
		await upsertCalendarReminder(ctx, userId, row, due, normalizeTimeZone(profile?.timeZone));
	} catch {
		reminderFailed(subscriptionId, "calendar_sync_failed");
	}
}
