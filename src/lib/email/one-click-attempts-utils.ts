/** The audit action of a one-click unsubscribe request (`src/lib/email/one-click-attempts.ts`). */
export const UNSUBSCRIBE_ONE_CLICK_ACTION = "message.unsubscribe_one_click";

/** One request per user and message in this window, counting only requests that went out. */
export const MESSAGE_COOLDOWN_MS = 10 * 60_000;
/** And at most this many requests a minute per user, whatever the message. */
const USER_ATTEMPTS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

/** Outcomes of requests that were refused here and sent nothing: they never count against anything. */
const REFUSED_OUTCOMES = new Set(["duplicate", "rate_limited"]);
/** Outcomes of requests that are going out or reached the sender: these hold the per-message window. */
const SENT_OUTCOMES = new Set(["pending", "done"]);

export type OneClickAttemptRow = {
	id: string;
	/** Insertion order (SQLite `rowid`): `created_at` holds whole seconds, too coarse to order requests. */
	seq: number;
	messageId: string | null;
	createdAt: number;
	/** `metadata.outcome`; a row without one is still pending. */
	outcome: string | null;
};

/**
 * Whether the request `self` (its own row already among `rows`, the user's rows of the last ten minutes) may go out.
 * Refused requests are ignored, so clicking again never stretches a window. Per message only requests that are
 * pending or reached the sender count, so a retry after a failure goes out; of any two the one inserted first goes out
 * and the other is a duplicate, the same answer whichever of them asks. Per user every request
 * that went out in the last minute counts, failed or not.
 */
export function decideOneClickAttempt(
	rows: readonly OneClickAttemptRow[],
	self: { id: string; messageId: string },
	now: number,
): "duplicate" | "rate_limited" | null {
	const live = rows.filter((row) => !REFUSED_OUTCOMES.has(row.outcome ?? "pending"));
	const holding = live
		.filter(
			(row) =>
				row.messageId === self.messageId &&
				row.createdAt > now - MESSAGE_COOLDOWN_MS &&
				SENT_OUTCOMES.has(row.outcome ?? "pending"),
		)
		.sort((a, b) => a.seq - b.seq);
	if (holding.length && holding[0]!.id !== self.id) return "duplicate";
	const lastMinute = live.filter((row) => row.createdAt > now - MINUTE_MS).length;
	return lastMinute > USER_ATTEMPTS_PER_MINUTE ? "rate_limited" : null;
}

/** The `outcome` of a row's metadata JSON, or null when it has none or cannot be read. */
export function attemptOutcome(metadata: string | null): string | null {
	if (!metadata) return null;
	try {
		const parsed: unknown = JSON.parse(metadata);
		const outcome = parsed && typeof parsed === "object" ? (parsed as { outcome?: unknown }).outcome : null;
		return typeof outcome === "string" ? outcome : null;
	} catch {
		return null;
	}
}
