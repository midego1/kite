import { customAlphabet } from "nanoid";

/** Feed tokens look nothing like API keys (`ep_`), so neither can be mistaken for the other in a log or a form. */
const FEED_TOKEN_PREFIX = "kcf_";
const FEED_TOKEN_SECRET_LENGTH = 32;
const FEED_TOKEN_PATTERN = /^kcf_[0-9A-Za-z]{32}$/;
/** 62^32 is about 190 bits: guessing a token is out of reach even without the rate limit. */
const secret = customAlphabet(
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
	FEED_TOKEN_SECRET_LENGTH,
);

export function generateFeedToken(): string {
	return `${FEED_TOKEN_PREFIX}${secret()}`;
}

/** The indexed lookup part stored in `api_keys.prefix`; the whole token is only ever stored as its hash. */
export function feedTokenPrefix(token: string): string {
	return token.slice(0, 12);
}

/** The token from the last path segment (`<token>.ics`, the extension optional), or `null` when it cannot be one. */
export function parseFeedTokenSegment(segment: string): string | null {
	const token = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
	return FEED_TOKEN_PATTERN.test(token) ? token : null;
}

/** The path a calendar app subscribes to; the origin is added by whoever shows it. */
export function calendarFeedPath(token: string): string {
	return `/api/public/calendar/feed/${token}.ics`;
}

export async function hashFeedToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
