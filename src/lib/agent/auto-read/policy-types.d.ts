import type { MessageFacts } from "./facts-types";
import type { AutoReadCapabilities, AutonomyLevel } from "./settings-types";
import type { CalendarInvitePayload } from "./suggestion-types";
import type { TriageResult } from "./triage-types";

export type AgentActionType =
	| "create_draft"
	| "move"
	| "mark_read"
	| "set_folder"
	| "remind"
	| "create_event"
	| "delete_event"
	| "send_rsvp"
	| "send_reply"
	| "unsubscribe"
	| "dismiss";

/** A matched `agent_sender_policies` row. */
export type SenderPolicy = {
	pattern: string;
	requireAuth: boolean;
	allowedActions: string[];
	templateRule: string | null;
};

export type ExecutionContext = {
	capabilities: Pick<AutoReadCapabilities, "calendar" | "reply">;
	/** `app_settings.agent_full_auto_allowed`. */
	fullAutoAllowed: boolean;
	paused?: boolean;
	/** A daily, spend or send cap is reached. */
	capReached?: boolean;
	/** The model flagged the message; it can only make the policy stricter. */
	modelFlagged?: boolean;
	/** The invite overlaps the reviewer's calendar. */
	hasConflict?: boolean;
	/** For sends: the one recipient code chose. */
	recipient?: string;
	/** For RSVPs: the ICS ORGANIZER address. */
	organizer?: string | null;
	rsvp?: "accepted" | "declined";
	/** Automatic sends already made in this thread in the last 24 hours. */
	threadAutoSendsLast24h?: number;
};

export type ExecutionDecision = { allowed: boolean; rule: string; level: AutonomyLevel };

export type PlanSettings = {
	capabilities: AutoReadCapabilities;
	/** The reviewer holds `canSendOnBehalf`, which reply drafts need. */
	canDraftReply: boolean;
	/** A mailbox rule filed the message into a folder. */
	filed: boolean;
	threadMessageCount: number;
};

export type PlanInput = {
	facts: MessageFacts;
	triage: TriageResult | null;
	settings: PlanSettings;
	/** The parsed and checked invite, when one was attached. */
	invite?: CalendarInvitePayload | null;
};
