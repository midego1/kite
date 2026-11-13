import type { MailingListHeaders, MailingListInfo } from "@/lib/email/mailing-list-types";

const ALLOWED_UNSUBSCRIBE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_LIST_NAME_LENGTH = 80;
const MAX_LIST_ID_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
// Control, format and bidi characters a list name could use to disguise itself or the text around it.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f­؜​-‏‪-‮⁠-⁯﻿]/g;
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function normalizeCandidate(value: string): string {
	return value.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
}

function isAllowedUnsubscribeUrl(value: string): boolean {
	if (value.length > MAX_URL_LENGTH) return false;
	try {
		return ALLOWED_UNSUBSCRIBE_PROTOCOLS.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

/** Every URL a `List-Unsubscribe` value names: the bracketed ones (RFC 2369), then bare comma-separated ones. */
function unsubscribeCandidates(values: readonly string[]): string[] {
	return values
		.flatMap((value) => {
			const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => normalizeCandidate(match[1] ?? ""));
			const bare = value.split(",").map(normalizeCandidate);
			return [...bracketed, ...bare];
		})
		.filter(Boolean)
		.filter(isAllowedUnsubscribeUrl);
}

/** The link a reader may follow: an `http(s)` URL first, else a `mailto:` one. */
export function pickUnsubscribeUrl(values: readonly string[]): string | null {
	const candidates = unsubscribeCandidates(values);
	return (
		candidates.find((candidate) => /^https?:\/\//i.test(candidate)) ??
		candidates.find((candidate) => /^mailto:/i.test(candidate)) ??
		null
	);
}

/**
 * The `https` URL for an RFC 8058 one-click POST, or null: `List-Unsubscribe-Post` must be exactly
 * `List-Unsubscribe=One-Click` (one field, as §3.1 requires) and `List-Unsubscribe` must name an `https` URI.
 */
function pickOneClickUrl(unsubscribeValues: readonly string[], postValues: readonly string[]): string | null {
	if (postValues.length !== 1) return null;
	if (postValues[0]!.trim().toLowerCase() !== "list-unsubscribe=one-click") return null;
	return unsubscribeCandidates(unsubscribeValues).find((candidate) => /^https:\/\//i.test(candidate)) ?? null;
}

/** The header names one `DKIM-Signature` signs (its `h=` tag), lower-case; empty when it has none. */
function dkimSignedHeaders(signature: string): string[] {
	for (const tag of signature.split(";")) {
		const separator = tag.indexOf("=");
		if (separator < 0) continue;
		if (tag.slice(0, separator).trim().toLowerCase() !== "h") continue;
		return tag
			.slice(separator + 1)
			.split(":")
			.map((name) => name.replace(/\s+/g, "").toLowerCase())
			.filter(Boolean);
	}
	return [];
}

/** Whether some `DKIM-Signature` signs both `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058 §4). */
function dkimCoversListUnsubscribe(signatures: readonly string[]): boolean {
	return signatures.some((signature) => {
		const signed = new Set(dkimSignedHeaders(signature));
		return signed.has("list-unsubscribe") && signed.has("list-unsubscribe-post");
	});
}

function decodeQ(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === "_") bytes.push(0x20);
		else if (char === "=" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
			bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
			index += 2;
		} else bytes.push(char.charCodeAt(0) & 0xff);
	}
	return Uint8Array.from(bytes);
}

function decodeB(text: string): Uint8Array {
	const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** RFC 2047 encoded words in a header phrase, decoded; null when one cannot be (unknown charset, bad base64). */
function decodeEncodedWords(value: string): string | null {
	try {
		// Whitespace between two adjacent encoded words is not part of the text (RFC 2047 §6.2).
		const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
		return joined.replace(ENCODED_WORD, (_match, charset: string, encoding: string, text: string) => {
			const bytes = encoding.toLowerCase() === "b" ? decodeB(text) : decodeQ(text);
			return new TextDecoder(charset.replace(/\*.*$/, "").toLowerCase(), { fatal: true }).decode(bytes);
		});
	} catch {
		return null;
	}
}

/** A list name for display: decoded, unquoted, without control or bidi characters, at most 80 characters. */
function cleanListName(phrase: string): string | null {
	const decoded = decodeEncodedWords(phrase.trim());
	if (decoded === null) return null;
	const unquoted = decoded.replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1");
	const clean = unquoted.replace(UNSAFE_TEXT, "").replace(/\s+/g, " ").trim();
	if (!clean) return null;
	return clean.length > MAX_LIST_NAME_LENGTH ? `${clean.slice(0, MAX_LIST_NAME_LENGTH - 1).trimEnd()}…` : clean;
}

/**
 * `List-Id: Kite News <news.kite.example>` as `{ id: "news.kite.example", name: "Kite News" }`. The identifier is
 * the bracketed dot-atom (RFC 2919 §2); a value without brackets counts as a bare identifier when it is one token.
 */
function parseListId(value: string | undefined): { id: string | null; name: string | null } {
	if (!value) return { id: null, name: null };
	const bracket = value.match(/<([^<>]*)>\s*$/);
	const rawId = (bracket ? bracket[1]! : /^\S+$/.test(value.trim()) ? value.trim() : "").trim().toLowerCase();
	const id = rawId && rawId.length <= MAX_LIST_ID_LENGTH && /^[\x21-\x7e]+$/.test(rawId) ? rawId : null;
	const name = bracket ? cleanListName(value.slice(0, bracket.index)) : null;
	return { id, name: id ? name : null };
}

/** What a message's list headers say, from its parsed header block (lower-case names, every value). */
export function readMailingListHeaders(headers: ReadonlyMap<string, readonly string[]>): MailingListHeaders {
	const unsubscribe = headers.get("list-unsubscribe") ?? [];
	const { id, name } = parseListId(headers.get("list-id")?.[0]);
	return {
		listId: id,
		listName: name,
		unsubscribeUrl: pickUnsubscribeUrl(unsubscribe),
		oneClickUrl: pickOneClickUrl(unsubscribe, headers.get("list-unsubscribe-post") ?? []),
		dkimCoversUnsubscribe: dkimCoversListUnsubscribe(headers.get("dkim-signature") ?? []),
	};
}

/** Whether a message is from a mailing list at all: it names a list or a way to leave one. */
function isMailingList(headers: MailingListHeaders | null): headers is MailingListHeaders {
	return !!headers && (!!headers.listId || !!headers.unsubscribeUrl);
}

/**
 * Whether Kite may send the one-click POST: the message asks for it, a DKIM signature covers both headers and the
 * intake hop reported a DKIM pass (RFC 8058 §4). Kite stores the pass, not which signature passed, so a message
 * with several signatures counts when any passed and any covers the headers.
 */
export function canUseOneClick(headers: MailingListHeaders | null, dkimPassed: boolean): boolean {
	return !!headers?.oneClickUrl && headers.dkimCoversUnsubscribe && dkimPassed;
}

/**
 * The reader's view of the list: null when the message is not from one. One-click only when the viewer may
 * unsubscribe (full access to the mailbox, and the message is not spam or held).
 */
export function mailingListInfo(
	headers: MailingListHeaders | null,
	viewer: { dkimPassed: boolean; mayUnsubscribe: boolean },
): MailingListInfo | null {
	if (!isMailingList(headers)) return null;
	return {
		id: headers.listId,
		name: headers.listName,
		oneClick: viewer.mayUnsubscribe && canUseOneClick(headers, viewer.dkimPassed),
	};
}

/** Whether stored spam signals (`messages.spam_signals`, JSON) record a DKIM pass from the intake hop. */
export function storedDkimPassed(spamSignals: string | null | undefined): boolean {
	if (!spamSignals) return false;
	try {
		const parsed: unknown = JSON.parse(spamSignals);
		return (
			Array.isArray(parsed) &&
			parsed.some(
				(signal) => !!signal && typeof signal === "object" && (signal as { id?: unknown }).id === "dkim_passed",
			)
		);
	} catch {
		return false;
	}
}
