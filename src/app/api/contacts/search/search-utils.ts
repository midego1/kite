const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;

/** `limit` from the query string: a whole number from 1 to 20, 8 when absent or not a number. */
export function parseContactSearchLimit(value: string | null): number {
	const parsed = Math.trunc(Number(value));
	if (!value || !Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

/** The search text: trimmed, cut to 200 characters, empty when there is nothing to look for. */
export function normalizeContactQuery(value: string | null): string {
	return (value ?? "").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * A `LIKE` pattern that matches the query anywhere in a name or address. `%`, `_` and the escape
 * character itself are escaped (`ESCAPE '\'`), so a typed `%` matches a literal percent sign.
 */
export function contactLikePattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export type ContactSearchRow = {
	email: string;
	displayName: string | null;
	avatarKey: string | null;
	blocked: boolean;
	lastSeenAt: Date | null;
};

export type ContactSearchHit = {
	email: string;
	displayName: string | null;
	hasAvatar: boolean;
	blocked: boolean;
	/** The Screener still holds mail from this address, so it is not a correspondent yet. */
	heldByScreener: boolean;
};

/** The wire form of a contact row: the avatar as a flag, never its storage key; `held` lists the addresses the Screener holds. */
export function toContactSearchHit(row: ContactSearchRow, held: ReadonlySet<string> = new Set()): ContactSearchHit {
	return {
		email: row.email,
		displayName: row.displayName,
		hasAvatar: !!row.avatarKey,
		blocked: row.blocked,
		heldByScreener: held.has(row.email),
	};
}
