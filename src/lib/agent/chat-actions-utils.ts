import { z } from "zod";
import type { ChatActionPlan, ChatActionState, MessagePlace } from "./chat-actions-types";

const ids = z.array(z.string()).min(1).max(20);
const destination = z.enum(["inbox", "archived", "trash", "spam"]);

/** The proposals a chat tool result can carry while it waits for the user's approval. */
export const chatProposalSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("move_email"),
		status: z.literal("pending_approval"),
		emailIds: ids.length(1),
		destination,
	}),
	z.object({ action: z.literal("move_emails"), status: z.literal("pending_approval"), emailIds: ids, destination }),
	z.object({
		action: z.literal("mark_email_read"),
		status: z.literal("pending_approval"),
		emailId: z.string(),
		read: z.boolean(),
	}),
	z.object({ action: z.literal("mark_emails_read"), status: z.literal("pending_approval"), emailIds: ids }),
	z.object({ action: z.literal("mark_emails_unread"), status: z.literal("pending_approval"), emailIds: ids }),
	z.object({
		action: z.literal("create_folder"),
		status: z.literal("pending_approval"),
		name: z.string().min(1).max(80),
		color: z.string(),
	}),
	z.object({
		action: z.literal("move_emails_to_folder"),
		status: z.literal("pending_approval"),
		emailIds: ids,
		folderId: z.string(),
	}),
	z.object({
		action: z.literal("discard_draft"),
		status: z.literal("pending_approval"),
		draftId: z.string(),
		expectedRevision: z.number().int().positive(),
	}),
]);

/** The tool call that performs an approved proposal, and the audit row that makes it undoable. */
export function chatActionPlan(proposal: z.infer<typeof chatProposalSchema>): ChatActionPlan {
	const tool = proposal.action;
	switch (proposal.action) {
		case "move_email":
			return {
				tool,
				input: { emailId: proposal.emailIds[0], destination: proposal.destination },
				audit: { action: "move", variant: proposal.destination, emailIds: proposal.emailIds },
			};
		case "move_emails":
			return {
				tool,
				input: { emailIds: proposal.emailIds, destination: proposal.destination },
				audit: { action: "move", variant: proposal.destination, emailIds: proposal.emailIds },
			};
		case "mark_email_read":
			return {
				tool,
				input: { emailId: proposal.emailId, read: proposal.read },
				audit: { action: "mark_read", variant: proposal.read ? "read" : "unread", emailIds: [proposal.emailId] },
			};
		case "mark_emails_read":
		case "mark_emails_unread":
			return {
				tool,
				input: { emailIds: proposal.emailIds },
				audit: {
					action: "mark_read",
					variant: proposal.action === "mark_emails_read" ? "read" : "unread",
					emailIds: proposal.emailIds,
				},
			};
		case "create_folder":
			return {
				tool,
				input: { name: proposal.name, color: proposal.color },
				audit: { action: "create_folder", variant: "", emailIds: [] },
			};
		case "move_emails_to_folder":
			return {
				tool,
				input: { emailIds: proposal.emailIds, folderId: proposal.folderId },
				audit: { action: "set_folder", variant: "", emailIds: proposal.emailIds },
			};
		case "discard_draft":
			return { tool, input: { draftId: proposal.draftId, expectedRevision: proposal.expectedRevision }, audit: null };
	}
}

function isMessagePlace(value: unknown): value is MessagePlace {
	if (!value || typeof value !== "object") return false;
	const place = value as Record<string, unknown>;
	return (
		typeof place.id === "string" &&
		typeof place.status === "string" &&
		(place.folderId === null || typeof place.folderId === "string") &&
		typeof place.read === "boolean"
	);
}

function placeList(value: unknown): MessagePlace[] {
	return Array.isArray(value) ? value.filter(isMessagePlace) : [];
}

/** Marks the `before` of a row written by an approved chat action, so undo never guesses from its shape. */
const CHAT_ACTION_SOURCE = "chat";

/** The state a chat action row keeps for its undo: each message before and right after the effect. */
export function chatActionState(before: MessagePlace[], after: MessagePlace[]): ChatActionState {
	return { source: CHAT_ACTION_SOURCE, messages: before, applied: after };
}

/** The saved state of a row written by an approved chat action, or null for any other row (a phishing "Mark as spam"). */
export function storedChatActionState(before: Record<string, unknown> | null): ChatActionState | null {
	if (before?.source !== CHAT_ACTION_SOURCE) return null;
	return { source: CHAT_ACTION_SOURCE, messages: placeList(before.messages), applied: placeList(before.applied) };
}

/**
 * What an undo may change: the messages the action really changed in `field`, each with the state the
 * action left it in. An undo then touches a message only while it is still exactly in that state.
 */
export function undoTargets(
	state: ChatActionState,
	field: "place" | "read",
): { before: MessagePlace; applied: MessagePlace }[] {
	const applied = new Map(state.applied.map((place) => [place.id, place]));
	return state.messages.flatMap((before) => {
		const after = applied.get(before.id);
		if (!after) return [];
		const changed =
			field === "read"
				? before.read !== after.read
				: before.status !== after.status || before.folderId !== after.folderId;
		return changed ? [{ before, applied: after }] : [];
	});
}

const DATABASE_ERROR = /failed query|sqlite|constraint|d1_|params:/i;

/** An error message safe to show and store: database errors carry SQL and bound values, so they become a plain sentence. */
export function safeActionError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return !message || DATABASE_ERROR.test(message) ? "The action could not be completed" : message;
}
