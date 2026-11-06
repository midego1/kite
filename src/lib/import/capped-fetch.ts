import type { ImapSession } from "@/lib/imap/session";
import type { ImapFetchedMessage, ImapLimits } from "@/lib/imap/types";
import { oversizedNote, planFetchBatches } from "./capped-fetch-utils";

export type CappedFetch = {
	fetched: Map<string, ImapFetchedMessage>;
	/** One line per message left out for its size, naming the folder, the UID and the size. */
	skipped: string[];
};

/**
 * Fetches `uids` the way an import needs them: the sizes first (`UID FETCH … (UID RFC822.SIZE)`, about 40 bytes of answer
 * per message), then only messages within the connection's message limit, in groups that fit in memory. A message above
 * the limit is not fetched, so it cannot fail the whole batch (and, retried, the job): it is named in `skipped`, and
 * the caller counts the UID as skipped because it is missing from `fetched`.
 */
export async function fetchWithinSizeCap(
	session: ImapSession,
	uids: string[],
	options: { gmailLabels?: boolean },
	limits: Pick<ImapLimits, "literalBytes">,
	folder: string,
): Promise<CappedFetch> {
	const fetched = new Map<string, ImapFetchedMessage>();
	if (uids.length === 0) return { fetched, skipped: [] };
	const sizes = new Map<string, number | null>();
	for (const summary of await session.fetchUidSizes(uids)) sizes.set(String(summary.uid), summary.size);
	const plan = planFetchBatches(uids, sizes, { messageBytes: limits.literalBytes });
	for (const batch of plan.batches)
		for (const [uid, message] of await session.fetchMessages(batch, options)) fetched.set(uid, message);
	return {
		fetched,
		skipped: plan.oversized.map((message) => oversizedNote(folder, message, limits.literalBytes)),
	};
}
