import type { UnsubscribeUrl } from "@/lib/email/unsubscribe-types";
import type { MailingListHeaders } from "@/lib/email/mailing-list-types";
import { pickUnsubscribeUrl, readMailingListHeaders } from "@/lib/email/mailing-list-utils";
import { MAX_RAW_HEADER_BYTES, parseRawHeaders } from "@/lib/email/raw-headers";

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
	return readMailingListHeaders(parseRawHeaders(await raw.arrayBuffer()));
}

export async function getUnsubscribeUrlFromRawR2Key(
	env: CloudflareEnv,
	rawR2Key: string | null,
): Promise<UnsubscribeUrl> {
	return (await getMailingListHeadersFromRawR2Key(env, rawR2Key))?.unsubscribeUrl ?? null;
}
