import { z } from "zod";
import type { EmailToolName } from "./types";

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

export type ChatProposal = z.infer<typeof chatProposalSchema>;

/** How an approved proposal is recorded in `agent_actions`; null for an action that is not undoable. */
export type ChatActionAudit = {
	action: "move" | "mark_read" | "set_folder" | "create_folder";
	variant: string;
	emailIds: string[];
};

export type ChatActionPlan = { tool: EmailToolName; input: Record<string, unknown>; audit: ChatActionAudit | null };

/** The tool call that performs an approved proposal, and the audit row that makes it undoable. */
export function chatActionPlan(proposal: ChatProposal): ChatActionPlan {
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

/** One message as it was before an approved chat action changed it. */
export type MessagePlace = { id: string; status: string; folderId: string | null; read: boolean };

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

/** The messages a chat action row saved in `before`, or null when the row has none (an older single-message move). */
export function storedMessagePlaces(before: Record<string, unknown> | null): MessagePlace[] | null {
	const list = before?.messages;
	if (!Array.isArray(list)) return null;
	return list.filter(isMessagePlace);
}

/** The status a chat move leaves its messages in, so an undo touches only messages still there. */
export function movedStatus(variant: string): string {
	return variant === "inbox" ? "received" : variant;
}
