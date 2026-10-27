import type { AgentSendSnapshot } from "./types";

/** What confirming a send answers when the draft no longer matches the reviewed snapshot. */
export const DRAFT_CHANGED_ERROR = "Draft changed; review it again";

/**
 * The text the send approval hashes: fixed key order, attachments by id, nothing time-dependent but the
 * requested send time, so the same draft always gives the same string however its rows were read.
 */
export function canonicalSnapshotJson(payload: AgentSendSnapshot): string {
	const attachments = [...payload.attachments]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map(({ id, filename, size, digest }) => ({ id, filename, size, digest }));
	return JSON.stringify({
		from: payload.from,
		to: payload.to,
		cc: payload.cc,
		bcc: payload.bcc,
		subject: payload.subject,
		text: payload.text,
		html: payload.html,
		inReplyTo: payload.inReplyTo,
		references: payload.references,
		threadId: payload.threadId,
		mailboxId: payload.mailboxId,
		scheduledAt: payload.scheduledAt,
		attachments,
	});
}

/** The sendable columns a draft save writes. */
export type DraftSendableFields = {
	mailboxId: string | null;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
};

/**
 * Whether a draft save changes what would be sent. A save that writes the same values (an autosave of an
 * untouched composer) must not count as an edit, or it invalidates a pending send review.
 */
export function draftSaveChangesPayload(
	before: DraftSendableFields & { scheduledAt?: Date | null },
	after: DraftSendableFields & { scheduledAt?: Date | null },
): boolean {
	const keys: (keyof DraftSendableFields)[] = [
		"mailboxId",
		"fromAddr",
		"toAddr",
		"ccAddr",
		"bccAddr",
		"subject",
		"textBody",
		"htmlBody",
	];
	if (keys.some((key) => (before[key] ?? null) !== (after[key] ?? null))) return true;
	if (after.scheduledAt === undefined) return false;
	return (before.scheduledAt?.getTime() ?? null) !== (after.scheduledAt?.getTime() ?? null);
}
