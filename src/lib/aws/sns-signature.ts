/**
 * Amazon SNS message signatures (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html),
 * checked with Web Crypto so it runs on Workers and Node. The signing certificate is only fetched
 * from `https://sns.<region>.amazonaws.com/…pem` for the topic's own region, which is how AWS says to
 * tell its certificates apart; its validity dates are checked and its key is cached per isolate.
 */

export type SignedSnsEnvelope = {
	Type?: string;
	MessageId?: string;
	TopicArn?: string;
	Subject?: string;
	Message?: string;
	Timestamp?: string;
	Token?: string;
	SubscribeURL?: string;
	SignatureVersion?: string;
	Signature?: string;
	SigningCertURL?: string;
};

const HASHES: Record<string, "SHA-1" | "SHA-256"> = { "1": "SHA-1", "2": "SHA-256" };
const CACHE_MS = 24 * 60 * 60_000;
const MAX_CACHED = 8;
const keys = new Map<string, { key: CryptoKey; notAfter: number; fetchedAt: number }>();

/** The text SNS signed: the listed fields, each as `Name\nvalue\n`, in this order. */
export function snsStringToSign(envelope: SignedSnsEnvelope): string | null {
	const fields =
		envelope.Type === "Notification"
			? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: envelope.Type === "SubscriptionConfirmation" || envelope.Type === "UnsubscribeConfirmation"
				? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
				: null;
	if (!fields) return null;
	let text = "";
	for (const field of fields) {
		const value = envelope[field as keyof SignedSnsEnvelope];
		if (value === undefined) {
			// Only a notification's Subject is optional.
			if (field === "Subject") continue;
			return null;
		}
		text += `${field}\n${value}\n`;
	}
	return text;
}

/** A signing certificate URL for this region only: HTTPS, `sns.<region>.amazonaws.com`, a `.pem` path. */
export function snsCertificateUrl(value: string | undefined, region: string): URL | null {
	if (!value || !/^[a-z0-9-]+$/.test(region)) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const pinned =
		url.protocol === "https:" && url.hostname === `sns.${region}.amazonaws.com` && !url.port && !url.username;
	return pinned && url.pathname.endsWith(".pem") ? url : null;
}

/** `offset` is the tag byte, `start`/`end` bound the contents. */
type Tlv = { tag: number; offset: number; start: number; end: number };

/** One DER tag-length-value at `offset`. */
function readTlv(bytes: Uint8Array, offset: number): Tlv {
	const tag = bytes[offset];
	let length = bytes[offset + 1];
	if (tag === undefined || length === undefined) throw new Error("Truncated certificate");
	let start = offset + 2;
	if (length & 0x80) {
		const count = length & 0x7f;
		if (count < 1 || count > 4) throw new Error("Unsupported certificate length");
		length = 0;
		for (let index = 0; index < count; index++) length = length * 256 + (bytes[start + index] ?? 0);
		start += count;
	}
	const end = start + length;
	if (end > bytes.length) throw new Error("Truncated certificate");
	return { tag, offset, start, end };
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
	const list: Tlv[] = [];
	for (let offset = parent.start; offset < parent.end;) {
		const child = readTlv(bytes, offset);
		list.push(child);
		offset = child.end;
	}
	return list;
}

/** UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`), in ms. */
function derTime(bytes: Uint8Array, tlv: Tlv): number {
	const text = new TextDecoder().decode(bytes.subarray(tlv.start, tlv.end));
	const match = (
		tlv.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/
	).exec(text);
	if (!match) throw new Error("Unsupported certificate time");
	const year = Number(match[1]) + (tlv.tag === 0x17 ? (Number(match[1]) < 50 ? 2000 : 1900) : 0);
	return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

/** The subject public key and validity of an X.509 certificate in PEM form. */
export function parseCertificate(pem: string): { spki: Uint8Array<ArrayBuffer>; notBefore: number; notAfter: number } {
	const base64 = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)?.[1]?.replace(/\s+/g, "");
	if (!base64) throw new Error("No certificate");
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	const [tbs] = children(bytes, readTlv(bytes, 0));
	if (!tbs) throw new Error("No certificate body");
	const fields = children(bytes, tbs);
	// [0] version, then serial, signature algorithm, issuer, validity, subject, subject public key info.
	const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
	const validity = fields[offset + 3];
	const spki = fields[offset + 5];
	if (!validity || !spki || spki.tag !== 0x30) throw new Error("Unexpected certificate layout");
	const [notBefore, notAfter] = children(bytes, validity);
	if (!notBefore || !notAfter) throw new Error("No certificate validity");
	return {
		spki: bytes.slice(spki.offset, spki.end),
		notBefore: derTime(bytes, notBefore),
		notAfter: derTime(bytes, notAfter),
	};
}

async function signingKey(
	url: URL,
	hash: "SHA-1" | "SHA-256",
	fetcher: typeof fetch,
	now: number,
): Promise<CryptoKey | null> {
	const cacheKey = `${hash} ${url.href}`;
	const cached = keys.get(cacheKey);
	if (cached && now - cached.fetchedAt < CACHE_MS && now < cached.notAfter) return cached.key;
	const response = await fetcher(url.href, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) return null;
	const certificate = parseCertificate(await response.text());
	if (now < certificate.notBefore || now > certificate.notAfter) return null;
	const key = await crypto.subtle.importKey("spki", certificate.spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, [
		"verify",
	]);
	if (keys.size >= MAX_CACHED) keys.delete(keys.keys().next().value as string);
	keys.set(cacheKey, { key, notAfter: certificate.notAfter, fetchedAt: now });
	return key;
}

/**
 * Whether SNS signed this message, with a certificate from the topic's region. Never throws: a
 * malformed message, an unreachable or unexpected certificate and a bad signature are all false.
 */
export async function verifySnsSignature(
	envelope: SignedSnsEnvelope,
	region: string,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<boolean> {
	try {
		const hash = HASHES[envelope.SignatureVersion ?? ""];
		const url = snsCertificateUrl(envelope.SigningCertURL, region);
		const text = snsStringToSign(envelope);
		if (!hash || !url || !text || !envelope.Signature) return false;
		const key = await signingKey(url, hash, fetcher, now);
		if (!key) return false;
		const signature = Uint8Array.from(atob(envelope.Signature), (char) => char.charCodeAt(0));
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(text));
	} catch {
		return false;
	}
}
