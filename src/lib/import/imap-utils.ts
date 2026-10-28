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

/** `import_jobs.secure` and the import form's TLS switch: on is implicit TLS, off is a required STARTTLS upgrade. */
export function imapSecurity(secure: boolean): "tls" | "starttls" {
	return secure ? "tls" : "starttls";
}
