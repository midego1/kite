import { z } from "zod";
import { parseActionState } from "./actions-utils";
import type { SuggestionKind, SuggestionStatus } from "./suggestion-types";

const SUGGESTION_STATUSES: readonly SuggestionStatus[] = [
	"open",
	"accepted",
	"dismissed",
	"expired",
	"superseded",
	"auto_applied",
];

export type SuggestionStatusFilter = SuggestionStatus | "all";

/**
 * The `status` query value. A list for one mailbox defaults to every status (so closed suggestions can
 * be inspected); the cross-mailbox list behind For you defaults to open ones. Null for an unknown value.
 */
export function parseStatusFilter(value: string | null, hasMailbox: boolean): SuggestionStatusFilter | null {
	if (value === null || value === "") return hasMailbox ? "all" : "open";
	if (value === "all") return "all";
	return (SUGGESTION_STATUSES as readonly string[]).includes(value) ? (value as SuggestionStatus) : null;
}

export const acceptSuggestionSchema = z.object({ option: z.string().min(1).max(40) });

export const dismissSuggestionSchema = z
	.object({ muteSender: z.boolean().optional(), discardDraft: z.boolean().optional() })
	.strict();

/** Options each kind can be accepted with; calendar invites join in a later milestone. */
const ACCEPT_OPTIONS: Partial<Record<SuggestionKind, readonly string[]>> = {
	reply: ["review"],
	phishing: ["mark_spam"],
};

export type AcceptRefusal = { status: 400 | 409; error: string };

/** Why a suggestion cannot be accepted with this option, or null. */
export function acceptRefusal(
	suggestion: { kind: SuggestionKind; status: SuggestionStatus; draftId: string | null },
	option: string,
): AcceptRefusal | null {
	const options = ACCEPT_OPTIONS[suggestion.kind];
	if (!options) return { status: 400, error: "This suggestion cannot be accepted yet" };
	if (!options.includes(option)) return { status: 400, error: "Unknown option for this suggestion" };
	// A repeated "Mark as spam" is answered by the executor's idempotency, not refused here.
	const repeat = suggestion.kind === "phishing" && suggestion.status === "accepted";
	if (suggestion.status !== "open" && !repeat) return { status: 409, error: "This suggestion is no longer open" };
	if (suggestion.kind === "reply" && !suggestion.draftId)
		return { status: 409, error: "The draft for this suggestion no longer exists" };
	return null;
}

/** Dismissing is allowed while open; a repeated dismiss is answered by the executor's idempotency. */
export function dismissRefusal(status: SuggestionStatus): AcceptRefusal | null {
	return status === "open" || status === "dismissed"
		? null
		: { status: 409, error: "This suggestion is no longer open" };
}

type SuggestionRow = {
	id: string;
	mailboxId: string;
	messageId: string;
	threadId: string | null;
	kind: SuggestionKind;
	status: SuggestionStatus;
	title: string;
	payload: string;
	draftId: string | null;
	model: string | null;
	createdAt: Date;
	decidedAt: Date | null;
	expiresAt: Date | null;
	subject: string | null;
	from: string | null;
};

/** A suggestion as the API returns it, with its payload parsed and the message's subject and sender. */
export function toApiSuggestion(row: SuggestionRow) {
	return {
		id: row.id,
		mailboxId: row.mailboxId,
		messageId: row.messageId,
		threadId: row.threadId,
		kind: row.kind,
		status: row.status,
		title: row.title,
		payload: parseActionState(row.payload) ?? {},
		draftId: row.draftId,
		model: row.model,
		createdAt: row.createdAt.toISOString(),
		decidedAt: row.decidedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		message: { subject: row.subject, from: row.from },
	};
}
