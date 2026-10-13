import type { ModuleClient } from "../client-registry-types";
import { AnsweredInviteBlock, InviteBlock } from "./suggestion-invite-block";

/** Opens the calendar's new event dialog; the calendar page reads the param and drops it. */
export const commandHandlers: NonNullable<ModuleClient["commandHandlers"]> = {
	newEvent: ({ navigate }) => navigate("/calendar?new=event"),
};

export const suggestionCards: NonNullable<ModuleClient["suggestionCards"]> = {
	calendar_invite: { Block: InviteBlock, Answered: AnsweredInviteBlock },
};
