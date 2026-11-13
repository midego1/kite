import type { UnsubscribeUrl } from "@/lib/email/unsubscribe-types";
import type { MailingListHeaders } from "@/lib/email/mailing-list-types";
import { pickUnsubscribeUrl, readMailingListHeaders } from "@/lib/email/mailing-list-utils";
import { isUnsubscribeLoopbackAllowed } from "@/lib/email/one-click-unsubscribe-utils";
import { completeRawHeaderValues, MAX_RAW_HEADER_BYTES, parseRawHeaders } from "@/lib/email/raw-headers";

export function extractUnsubscribeUrlFromRaw(raw: ArrayBuffer): UnsubscribeUrl {
	return pickUnsubscribeUrl(parseRawHeaders(raw).get("list-unsubscribe") ?? []);
}

/** The list headers of a stored raw message (its first 64 KiB), or null when the object is gone. */
export async function getMailingListHeadersFromRawR2Key(
	env: CloudflareEnv,
	rawR2Key: string | null,
): Promise<MailingListHeaders | null> {
	if (!rawR2Key) return null;
	const raw = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: MAX_RAW_HEADER_BYTES } });
	if (!raw) return null;
	return readMailingListHeaders(parseRawHeaders(await raw.arrayBuffer()), {
		allowLoopback: isUnsubscribeLoopbackAllowed(env.UNSUBSCRIBE_ALLOW_LOOPBACK, process.env.NODE_ENV),
	});
}

/** Read whole for the one-click checks, so a field past the reader's 64 KiB cannot go unseen. */
const MAX_COMPLETE_HEADER_BYTES = 1024 * 1024;
const ONE_CLICK_FIELDS = ["list-unsubscribe", "list-unsubscribe-post", "dkim-signature", "list-id"] as const;

/**
 * The list headers for the one-click POST, read from a header block taken whole (up to 1 MiB) so the field counts and
 * the DKIM coverage are exact. Fails closed: `oneClickUrl` is null whenever any of the fields is uncertain (the block
 * does not end within 1 MiB, or `completeRawHeaderValues` cannot tell), and null when the object is gone.
 */
export async function getOneClickHeadersFromRawR2Key(
	env: CloudflareEnv,
	rawR2Key: string | null,
): Promise<MailingListHeaders | null> {
	if (!rawR2Key) return null;
	const object = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: MAX_COMPLETE_HEADER_BYTES } });
	if (!object) return null;
	const raw = await object.arrayBuffer();
	const options = {
		allowLoopback: isUnsubscribeLoopbackAllowed(env.UNSUBSCRIBE_ALLOW_LOOPBACK, process.env.NODE_ENV),
	};
	const fields = ONE_CLICK_FIELDS.map((name) => [name, completeRawHeaderValues(raw, name)] as const);
	if (fields.some(([, values]) => values === null)) {
		const partial = readMailingListHeaders(parseRawHeaders(raw), options);
		return { ...partial, oneClickUrl: null, dkimCoversUnsubscribe: false };
	}
	return readMailingListHeaders(new Map(fields as (readonly [string, string[]])[]), options);
}

export async function getUnsubscribeUrlFromRawR2Key(
	env: CloudflareEnv,
	rawR2Key: string | null,
): Promise<UnsubscribeUrl> {
	return (await getMailingListHeadersFromRawR2Key(env, rawR2Key))?.unsubscribeUrl ?? null;
}
