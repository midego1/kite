import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { reminderFailed, upsertCalendarReminder } from "./calendar-reminder";
import { dayInTimeZone } from "./date-utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import type { SubscriptionRow } from "./record-utils";
import { reminderNotice, reminderStep, renewalDuePayload } from "./reminder-utils";
import { claimReminder, dueRows, reminderOwner, type ReminderOwner } from "./reminder-store";

/** Rows handled per tick; the rest wait for the next one, five minutes later. */
const ROWS_PER_TICK = 100;

const RENEWAL_DUE = "finance.subscription.renewal_due";

type OwnerTick = {
	ctx: CapabilityCallContext;
	owner: ReminderOwner;
	timeZone: string;
	today: string;
	calendarOn: () => Promise<boolean>;
};

function tickTime(input: JsonValue): Date {
	const scheduled = (input as { scheduledTime?: unknown } | null)?.scheduledTime;
	const time = typeof scheduled === "string" ? new Date(scheduled) : new Date();
	return Number.isNaN(time.getTime()) ? new Date() : time;
}

async function attempt(subscriptionId: string, code: string, run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch {
		reminderFailed(subscriptionId, code);
	}
}

/**
 * One row of one owner: claim it once for its due date, then send the notice, the webhook and the
 * calendar event, each on its own so one failure never stops the others. Returns whether it reminded.
 */
async function remindRow(tick: OwnerTick, row: SubscriptionRow): Promise<boolean> {
	const step = reminderStep(row, tick.today);
	if (step.step === "wait" || !(await claimReminder(row.id, step.due.at))) return false;
	if (step.step === "silent") return false;
	const { ctx, owner } = tick;
	await attempt(row.id, "notify_failed", () =>
		moduleHost.notify(ctx, "finance", [owner.userId], reminderNotice(row, step.due, step.daysLeft, ctx.locale)),
	);
	await attempt(row.id, "webhook_failed", () =>
		moduleHost.emitWebhook(
			ctx,
			"finance",
			RENEWAL_DUE,
			renewalDuePayload(row, step.due, step.daysLeft) as unknown as JsonValue,
		),
	);
	if (row.calendarReminder && (await tick.calendarOn()))
		await upsertCalendarReminder(ctx, owner.userId, row, step.due, tick.timeZone);
	return true;
}

async function ownerTick(cron: CapabilityCallContext, userId: string, now: Date): Promise<OwnerTick | null> {
	if (!(await moduleHost.modules.isEnabledFor(cron, userId, "finance"))) return null;
	const owner = await reminderOwner(userId);
	if (!owner) return null;
	const timeZone = normalizeTimeZone(owner.timeZone);
	const ctx = buildCallContext({
		trigger: "cron",
		viewer: { userId, role: owner.role, isPrimaryAdmin: owner.isPrimaryAdmin },
		timeZone,
		requestId: cron.requestId,
		grants: cron.grants,
	});
	let calendar: Promise<boolean> | null = null;
	const calendarOn = () => (calendar ??= moduleHost.modules.isEnabledFor(ctx, userId, "calendar").catch(() => false));
	return { ctx, owner, timeZone, today: dayInTimeZone(now.toISOString(), timeZone), calendarOn };
}

/** A user restricted from Money Watch keeps their rows untouched, so the reminder fires once access returns. */
async function remindOwner(cron: CapabilityCallContext, userId: string, rows: SubscriptionRow[], now: Date) {
	let tick: OwnerTick | null;
	try {
		tick = await ownerTick(cron, userId, now);
	} catch {
		for (const row of rows) reminderFailed(row.id, "owner_failed");
		return 0;
	}
	if (!tick) return 0;
	let reminded = 0;
	for (const row of rows)
		try {
			if (await remindRow(tick, row)) reminded += 1;
		} catch {
			reminderFailed(row.id, "reminder_failed");
		}
	return reminded;
}

function byOwner(rows: readonly SubscriptionRow[]): Map<string, SubscriptionRow[]> {
	const owners = new Map<string, SubscriptionRow[]>();
	for (const row of rows) owners.set(row.userId, [...(owners.get(row.userId) ?? []), row]);
	return owners;
}

/**
 * The five-minute cron task (spec §10.1): reminds owners of rows inside their reminder window, on the
 * owner's calendar day, once per due date. Before migration 0063 it has nothing to do.
 */
export const remindRenewals: CapabilityHandler = async (input, ctx) => {
	const now = tickTime(input);
	let rows: SubscriptionRow[];
	try {
		rows = await dueRows(now, ROWS_PER_TICK);
	} catch (error) {
		if (refusalOf(error)?.error === MIGRATION_PENDING_ERROR) return { reminded: 0 };
		throw error;
	}
	let reminded = 0;
	for (const [userId, owned] of byOwner(rows)) reminded += await remindOwner(ctx, userId, owned, now);
	return { reminded };
};
