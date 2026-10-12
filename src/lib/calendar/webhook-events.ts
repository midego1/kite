import { createLogger } from "@/lib/logger.mjs";
import { moduleHost } from "@/lib/modules/host";
// Binds the payload schemas `emitWebhook` validates against.
import "@/lib/modules/invoke";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import {
	CALENDAR_WEBHOOK_EVENTS,
	calendarEventWebhookPayload,
	calendarWebhookContext,
	type CalendarWebhookKind,
	type CalendarWebhookRow,
	type CalendarWebhookUser,
} from "./webhook-event-utils";

const log = createLogger("calendar");

export type CalendarWrite = [CalendarWebhookKind, CalendarWebhookRow];

/**
 * Tells the acting user's webhooks about events that were just written. A refused or failed delivery is
 * logged and never fails the write that already happened.
 */
export async function emitCalendarWrites(
	who: CalendarWebhookUser | CapabilityCallContext,
	writes: readonly CalendarWrite[],
	trigger: CapabilityCallContext["trigger"] = "api",
): Promise<void> {
	const ctx = "requestId" in who ? who : calendarWebhookContext(who, trigger);
	for (const [kind, row] of writes) {
		try {
			await moduleHost.emitWebhook(ctx, "calendar", CALENDAR_WEBHOOK_EVENTS[kind], calendarEventWebhookPayload(row));
		} catch (error) {
			log.warn("calendar.webhook_failed", { kind, error });
		}
	}
}
