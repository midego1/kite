import { getEmailAddress, normalizeEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { isAutomaticMessage } from "@/lib/agent/auto-read/facts-utils";

/** Every assistant reply carries this, so a well-behaved auto-responder never answers it and Kite drops one that does. */
const X_KITE_ASSISTANT_HEADER = "x-kite-assistant";

function lowerHeaders(headers?: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

/**
 * Loop and auto-reply guards beyond the general `isAutomaticMessage` rules (docs/specs/assistant-by-email.md §6):
 * a bare `List-Unsubscribe` without `List-Id`, a delivery status report, and `X-Kite-Assistant`, which every
 * assistant reply sets so a misbehaving auto-responder's answer to it is dropped instead of starting a loop.
 * `X-Kite-Forwarded`/`X-Mailflare-Forwarded` are checked separately with `wasForwardedByKite`, which needs the
 * install's signing key and so cannot be a pure function.
 */
export function hasAssistantLoopHeader(from: string, headers: Record<string, string> | undefined): boolean {
	if (isAutomaticMessage(from, headers)) return true;
	const lower = lowerHeaders(headers);
	if (lower["list-unsubscribe"]) return true;
	if (lower[X_KITE_ASSISTANT_HEADER]) return true;
	if ((lower["content-type"] ?? "").toLowerCase().includes("multipart/report")) return true;
	return false;
}

/** An empty envelope sender (`<>`, a bounce) or nothing at all. */
export function isEmptyEnvelopeSender(from: string | null | undefined): boolean {
	const trimmed = (from ?? "").trim();
	return trimmed === "" || trimmed === "<>";
}

/** Whether the `From` header names exactly one address, as spec §5.2 requires. */
export function hasSingleFromAddress(fromHeader: string | null | undefined): boolean {
	if (!fromHeader) return false;
	return splitEmailAddressList(fromHeader).length === 1;
}

/** Whether a `Sender` header names an address other than the (already normalised) From address. */
export function senderHeaderNamesOther(senderHeader: string | null | undefined, fromAddress: string): boolean {
	if (!senderHeader) return false;
	const sender = normalizeEmailAddress(senderHeader);
	return !!sender && sender !== fromAddress;
}

/** Automatic senders no reply ever goes to: mailer-daemon, postmaster, or a no-reply address. */
export function isNonRepliableSender(address: string): boolean {
	return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(address);
}

const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REPLAY_MAX_FUTURE_MS = 60 * 60 * 1000;

/**
 * Whether a request's `Date` header is recent enough to act on: not more than 24 hours old and not more than an
 * hour in the future (clock skew aside), so a captured, validly signed request cannot be replayed later. A
 * missing `Date` fails closed.
 */
export function isWithinReplayWindow(date: Date | null, now: Date): boolean {
	if (!date || Number.isNaN(date.getTime())) return false;
	const age = now.getTime() - date.getTime();
	return age <= REPLAY_MAX_AGE_MS && age >= -REPLAY_MAX_FUTURE_MS;
}

/** The lower-cased, bracket-stripped Message-ID a header names, or null. */
export function normalizeMessageId(value: string | null | undefined): string | null {
	const trimmed = value?.trim().replace(/^<|>$/g, "").trim();
	return trimmed ? trimmed.toLowerCase() : null;
}

/** The normalised address of a `From` header, the way the rest of the codebase keys contacts and mailboxes. */
export function normalizedFromAddress(fromHeader: string): string {
	return normalizeEmailAddress(getEmailAddress(fromHeader));
}

const QUOTE_INTRO = /^on .{0,300}\bwrote:\s*$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}$/i;

/**
 * The text above a follow-up's quoted earlier answer (spec §8.5), cut at the first line that introduces a quote
 * ("On ... wrote:", "----- Original Message -----") or the first of two consecutive `>`-quoted lines. A text with
 * none of those is returned whole: better to wrap a little quoted text than to cut a genuine request short.
 */
export function stripQuotedReplyText(text: string): string {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (QUOTE_INTRO.test(line) || ORIGINAL_MESSAGE.test(line)) return lines.slice(0, index).join("\n").trim();
		if (line.startsWith(">") && lines[index + 1]?.trim().startsWith(">"))
			return lines.slice(0, index).join("\n").trim();
	}
	return text.trim();
}
