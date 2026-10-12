import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { CALENDAR_TOOL_NAMES } from "@/lib/calendar/tool-schemas";
import type { CalendarToolName } from "@/lib/calendar/tool-types";
import { toJsonOutput, withCalendarToolRefs } from "@/lib/calendar/tool-ref-utils";
import { runCalendarTool } from "@/lib/calendar/tools";
import { getEnv } from "@/lib/cloudflare";
import { AgentActionError } from "@/lib/agent/auto-read/action-error";
import {
	runCalendarAction,
	type CalendarActionCall,
	type CalendarActionName,
} from "@/lib/agent/auto-read/calendar-actions";
import { senderAddressOf } from "@/lib/agent/auto-read/facts-utils";
import { loadCalendarInvite } from "@/lib/agent/auto-read/invite";
import { answerInvite } from "@/lib/agent/auto-read/invite-actions";
import type { CapabilityHandler, JsonValue } from "../module-types";
import { resolveCalendarRefs } from "@/lib/calendar/refs";

type StepInput = { message: { id: string; from: string }; facts: { authPassed: boolean } };

/** Reads the invitation attached to the message and offers it as a suggestion of the module's own kind. */
const inviteStep: CapabilityHandler = async (input, ctx) => {
	if (!ctx.viewer) throw new Error("The invite step needs a reviewer");
	const { message, facts } = input as StepInput;
	const payload = await loadCalendarInvite(getEnv(), ctx, {
		messageId: message.id,
		reviewerUserId: ctx.viewer.userId,
		senderAddress: senderAddressOf(message.from),
		authPassed: facts.authPassed,
	});
	return {
		suggestions: payload
			? [{ kind: "calendar_invite", payload: payload as unknown as JsonValue, reason: "calendar_invite" }]
			: [],
	};
};

const answerInviteHandler: CapabilityHandler = async (input, ctx): Promise<JsonValue> => {
	try {
		const result = await answerInvite(getEnv(), ctx, input as Parameters<typeof answerInvite>[2]);
		return { result: result as unknown as JsonValue };
	} catch (error) {
		if (error instanceof AgentActionError)
			return { result: null, refused: { status: error.status, error: error.message } };
		throw error;
	}
};

const actionHandler =
	(name: CalendarActionName): CapabilityHandler =>
	(input, ctx) =>
		runCalendarAction(getEnv(), ctx, name, input as CalendarActionCall);

function toolHandler(name: CalendarToolName): CapabilityHandler {
	return async (input, ctx) => {
		if (!ctx.viewer) throw new Error("Calendar tools need a viewer");
		const env = getEnv();
		const [user] = await getDb(env).select().from(users).where(eq(users.id, ctx.viewer.userId)).limit(1);
		if (!user) throw new Error("Viewer not found");
		const output = await runCalendarTool({ env, user, timeZone: ctx.timeZone }, name, input);
		return withCalendarToolRefs(name, toJsonOutput(output));
	};
}

export const calendarHandlers: Record<string, CapabilityHandler> = {
	...Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, toolHandler(name)])),
	search: async () => ({ items: [] }),
	resolveRefs: resolveCalendarRefs,
	invite: inviteStep,
	answerInvite: answerInviteHandler,
	createEvent: actionHandler("createEvent"),
	deleteEvent: actionHandler("deleteEvent"),
	sendRsvp: actionHandler("sendRsvp"),
	timeZoneChanged: async () => ({ handled: false }),
};
