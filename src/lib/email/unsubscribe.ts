import type { UnsubscribeUrl } from "@/lib/email/unsubscribe-types";
import { MAX_RAW_HEADER_BYTES, parseRawHeaders } from "@/lib/email/raw-headers";

const allowedUnsubscribeProtocols = new Set(["http:", "https:", "mailto:"]);

function normalizeCandidate(value: string): string {
	return value.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
}

function isAllowedUnsubscribeUrl(value: string): boolean {
	try {
		return allowedUnsubscribeProtocols.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

function getCandidates(value: string): string[] {
	const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => normalizeCandidate(match[1] ?? ""));
	const bare = value.split(",").map(normalizeCandidate);
	return [...bracketed, ...bare].filter(Boolean);
}

export function extractUnsubscribeUrlFromRaw(raw: ArrayBuffer): UnsubscribeUrl {
	const headers = parseRawHeaders(raw);
	const values = headers.get("list-unsubscribe") ?? [];
	const candidates = values.flatMap(getCandidates).filter(isAllowedUnsubscribeUrl);
	return (
		candidates.find((candidate) => candidate.startsWith("https://") || candidate.startsWith("http://")) ??
		candidates.find((candidate) => candidate.startsWith("mailto:")) ??
		null
	);
}

export async function getUnsubscribeUrlFromRawR2Key(
	env: CloudflareEnv,
	rawR2Key: string | null,
): Promise<UnsubscribeUrl> {
	if (!rawR2Key) return null;
	const raw = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: MAX_RAW_HEADER_BYTES } });
	if (!raw) return null;
	return extractUnsubscribeUrlFromRaw(await raw.arrayBuffer());
}
