import { isBlockedHost } from "@/lib/security/outbound-url";
export function quoteImapString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseSearchUids(line: string): string[] {
	const match = line.match(/^\* SEARCH(?:\s+(.+))?$/i);
	if (!match?.[1]) return [];
	return match[1]
		.trim()
		.split(/\s+/)
		.filter((value) => /^\d+$/.test(value));
}

export type ImapUidBatch = {
	uids: string[];
	total: number;
	/** Offset to pass on the next request, or null when the folder is fully covered. */
	nextOffset: number | null;
};

/**
 * Picks one batch of UIDs, newest first. `offset` is how many of the newest
 * messages earlier batches already covered, so repeated requests with the
 * returned `nextOffset` walk back through the whole folder.
 */
export function selectImapUidBatch(allUids: string[], limit: number, offset: number): ImapUidBatch {
	const total = allUids.length;
	const safeOffset = Math.min(Math.max(Math.floor(offset) || 0, 0), total);
	const end = total - safeOffset;
	const start = Math.max(0, end - Math.max(Math.floor(limit) || 1, 1));
	const nextOffset = start > 0 ? safeOffset + (end - start) : null;
	return { uids: allUids.slice(start, end), total, nextOffset };
}

export function getLiteralLength(line: string): number | null {
	const match = line.match(/\{(\d+)\}$/);
	return match ? Number(match[1]) : null;
}

export function isTaggedCompletion(line: string, tag: string): boolean {
	return line.toUpperCase().startsWith(`${tag.toUpperCase()} `);
}

export function parseListMailboxName(line: string): string | null {
	const match = line.match(/^\* LIST\s+\([^\)]*\)\s+(?:"[^"]*"|NIL)\s+(.+)$/i);
	if (!match?.[1]) return null;
	const value = match[1].trim();
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return value || null;
}

export function assertSafeImapHost(host: string): void {
	if (isBlockedHost(host)) throw new Error("Private and local IMAP hosts are not allowed");
}

/** Reads the UID out of an untagged FETCH response line, if it carries one. */
export function parseFetchUid(line: string): string | null {
	const match = line.match(/\bUID\s+(\d+)/i);
	return match ? match[1] : null;
}

/**
 * UIDs still to import for a background job, newest first. `cursorUid` is the
 * lowest UID an earlier run already handled; null means nothing was handled yet.
 */
export function selectRemainingUids(allUids: string[], cursorUid: number | null): number[] {
	return allUids
		.map(Number)
		.filter((uid) => Number.isSafeInteger(uid) && uid > 0 && (cursorUid === null || uid < cursorUid))
		.sort((a, b) => b - a);
}

export function chunk<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
	return chunks;
}
