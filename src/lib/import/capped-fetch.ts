import type { ImapSession } from "@/lib/imap/session";
import type { ImapFetchedMessage } from "@/lib/imap/types";
import { oversizedNote, planFetchSegments, type FetchSegment } from "./capped-fetch-utils";

/** UIDs per size query, which keeps the command line short. */
const SIZE_QUERY_UIDS = 100;

/** A segment with the lines that name its oversized messages, ready to be fetched, written and noted. */
export type PlannedSegment = FetchSegment & { skipped: string[] };

/**
 * Plans how to fetch `uids` for an import: the sizes first (`UID FETCH … (UID RFC822.SIZE)`, about 40 bytes of answer
 * per message, no bodies), then segments (`planFetchSegments`) whose messages are within the connection's message limit
 * and together small enough to hold in memory. A message above the limit is not fetched, so it cannot fail the whole
 * batch (and, retried, the job): it is named in its segment's `skipped`, and the caller counts the UID as skipped because
 * it is missing from what the segment fetched. `messageBytes` is `ImapLimits.literalBytes`.
 */
export async function planSizedFetch(
	session: ImapSession,
	uids: string[],
	messageBytes: number,
	folder: string,
): Promise<PlannedSegment[]> {
	const sizes = new Map<string, number | null>();
	for (let index = 0; index < uids.length; index += SIZE_QUERY_UIDS)
		for (const summary of await session.fetchUidSizes(uids.slice(index, index + SIZE_QUERY_UIDS)))
			sizes.set(String(summary.uid), summary.size);
	return planFetchSegments(uids, sizes, { messageBytes }).map((segment) => ({
		...segment,
		skipped: segment.oversized.map((message) => oversizedNote(folder, message, messageBytes)),
	}));
}

/** Fetches the messages of one planned segment (nothing when it holds only oversized ones). */
export async function fetchSegment(
	session: ImapSession,
	segment: Pick<FetchSegment, "fetch">,
	options: { gmailLabels?: boolean },
): Promise<Map<string, ImapFetchedMessage>> {
	return segment.fetch.length ? session.fetchMessages(segment.fetch, options) : new Map();
}
