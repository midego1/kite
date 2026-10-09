/** Undo windows a user can pick for composer sends; 0 turns undo off. */
export const UNDO_SEND_SECONDS_OPTIONS = [0, 5, 10, 20, 30] as const;

export type UndoSendSeconds = (typeof UNDO_SEND_SECONDS_OPTIONS)[number];

export function isUndoSendSeconds(value: unknown): value is UndoSendSeconds {
	return typeof value === "number" && (UNDO_SEND_SECONDS_OPTIONS as readonly number[]).includes(value);
}

/**
 * When a composer send should leave the outbound queue. An explicit schedule
 * wins; otherwise the user's undo window holds the message briefly.
 */
export function resolveComposerSendTime(
	scheduledAt: string | undefined,
	undoSendSeconds: number,
	now = Date.now(),
): { scheduledAt: string | undefined; undoUntil: string | null } {
	if (scheduledAt) return { scheduledAt, undoUntil: null };
	if (!isUndoSendSeconds(undoSendSeconds) || undoSendSeconds === 0) return { scheduledAt: undefined, undoUntil: null };
	const until = new Date(now + undoSendSeconds * 1000).toISOString();
	return { scheduledAt: until, undoUntil: until };
}
