import type { ImapFetchedMessage } from "@/lib/imap/types";
import type { HostImportMessage } from "@/lib/modules/host-types";
import type { ImportMessageInput } from "./types";

export type ImapUidBatch = {
	uids: number[];
	total: number;
	/** Offset to pass on the next request, or null when the folder is fully covered. */
	nextOffset: number | null;
};

/**
 * Picks one batch of UIDs, newest first. `offset` is how many of the newest
 * messages earlier batches already covered, so repeated requests with the
 * returned `nextOffset` walk back through the whole folder.
 */
export function selectImapUidBatch(allUids: number[], limit: number, offset: number): ImapUidBatch {
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
export function selectRemainingUids(allUids: readonly number[], cursorUid: number | null): number[] {
	return allUids
		.filter((uid) => Number.isSafeInteger(uid) && uid > 0 && (cursorUid === null || uid < cursorUid))
		.sort((a, b) => b - a);
}

/**
 * The raw bytes one call to the module host carries at most (a message above it goes alone). A call holds the raw
 * message, its base64 text and the decoded copy at once, so a fetch of many big messages is handed over in several calls.
 */
export const HOST_IMPORT_GROUP_BYTES = 4 * 1024 * 1024;

/** @public Exercised by the unit tests. */
export function chunk<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
	return chunks;
}

/** `import_jobs.secure` and the import form's TLS switch: on is implicit TLS, off is a required STARTTLS upgrade. */
export function imapSecurity(secure: boolean): "tls" | "starttls" {
	return secure ? "tls" : "starttls";
}

/**
 * @public Exercised by the unit tests. The source's state to keep (spec §4.2): `\Seen` is read and `\Flagged` is starred, compared without case.
 * `\Answered`, `\Draft` and keywords are ignored.
 */
export function importFlagState(flags: readonly string[]): { read: boolean; starred: boolean } {
	const set = new Set(flags.map((flag) => flag.toLowerCase()));
	return { read: set.has("\\seen"), starred: set.has("\\flagged") };
}

/** An IMAP message for the direct import route: its bytes, read and starred state and INTERNALDATE. */
export function importMessageFromImap(filename: string, fetched: ImapFetchedMessage): ImportMessageInput {
	return { filename, raw: fetched.raw, ...importFlagState(fetched.flags), receivedAt: fetched.internalDate };
}

/** The same for a background job, which hands messages to the module host as JSON (`encode` makes the base64). */
export function hostImportMessageFromImap(
	filename: string,
	fetched: ImapFetchedMessage,
	encode: (raw: ArrayBuffer) => string,
): HostImportMessage {
	return {
		filename,
		raw: encode(fetched.raw),
		encoding: "base64",
		...importFlagState(fetched.flags),
		...(fetched.internalDate ? { receivedAt: fetched.internalDate.toISOString() } : {}),
	};
}
