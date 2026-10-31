/**
 * Conservative one-time code (OTP) extraction from a subject and a plain-text
 * body. Used server-side at delivery to annotate the realtime new-message
 * event, and client-side for the message reader chip; it is never persisted
 * in a column and callers must not log the result.
 *
 * Rules, all biased towards returning nothing over returning a wrong number:
 * - A candidate is 4–8 digits (optionally split once by a single space or dash
 *   in the middle, returned without the separator) or 6–8 letters and digits
 *   containing at least one of each. A lowercase letter makes the alphanumeric
 *   candidate count only when it fills its own line or follows an OTP keyword
 *   directly ("code: b77f3a").
 * - An OTP keyword must sit near the candidate (64 characters before or 32
 *   after): code, verify/verification, OTP, one-time, passcode, 2FA,
 *   authentication, confirm, plus Dutch eenmalig(e), verificatiecode, inlogcode.
 * - Rejected: candidates inside URLs, next to currency, in phone shapes
 *   (a leading +, (0xx) groups, spaced digit runs, 0800/090x service numbers),
 *   plausible years (1900–2099) in a date context, and numbers whose nearest
 *   descriptor is a label word such as order, invoice, factuur, bestelling,
 *   reference, booking or account.
 * - The subject is searched first, and its keywords also describe body
 *   candidates (a subject like "Verification code" over a body that is only
 *   "554108"); within one source, repeated occurrences of the same code are
 *   fine but two different valid candidates are ambiguous and yield null.
 *   Candidates that fill their own line or follow a keyword directly win over
 *   ones that only sit near a keyword.
 */

type OneTimeCodeInput = {
	subject: string | null | undefined;
	text: string | null | undefined;
};

/** Whitespace-delimited tokens that contain a URL marker, as sorted, non-overlapping [start, end) ranges. */
type UrlTokenRanges = Array<[number, number]>;

type CodeCandidate = {
	value: string;
	index: number;
	end: number;
	kind: "digits" | "alnum";
};

/** How far before a candidate an OTP keyword may sit. */
const KEYWORD_BEFORE_WINDOW = 64;
/** How far after a candidate an OTP keyword may sit. */
const KEYWORD_AFTER_WINDOW = 32;
/** How far before a candidate a number label word may sit. */
const LABEL_WINDOW = 20;
/** How far around a plausible year date words may sit. */
const DATE_CONTEXT_WINDOW = 24;
/** A plausible year additionally needs a keyword this close before it. */
const YEAR_KEYWORD_WINDOW = 24;
/**
 * Subject plus body characters above which no code is looked for. One-time code mails are short; a body this long is
 * a newsletter or a digest, where a "code" is more likely a coupon than a login, and scanning it costs main-thread
 * time in the reader.
 */
const MAX_ONE_TIME_CODE_SOURCE_LENGTH = 100_000;

const KEYWORD_SOURCE =
	"\\b(?:codes?|otps?|passcodes?|one[- ]time|eenmalig(?:e)?|verificatiecode|inlogcode|verif\\w*|authenticat\\w*|confirm\\w*|2fa)\\b";
const KEYWORD_RE = new RegExp(KEYWORD_SOURCE, "i");
const KEYWORD_GLOBAL_RE = new RegExp(KEYWORD_SOURCE, "gi");

const LABEL_SOURCE =
	"\\b(?:order|orders|invoice|invoices|factuur\\w*|bestel\\w*|purchase|purchases|receipt|receipts|reference|references|ref|booking|bookings|reservation|reservations|subscription|customer|klantnummer|account|tracking|transaction|transactions|postcode|postal|zip|nr\\.?)\\b";
const LABEL_GLOBAL_RE = new RegExp(LABEL_SOURCE, "gi");

/** Month names and other words that turn a plausible year into a date. */
const DATE_WORD_RE =
	/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|copyright|year|years|jaar)\b|©/i;

/** Dutch and other national service numbers, never one-time codes. */
const SERVICE_NUMBER_RE = /^(?:0800|0900|0906|0909)/;

/** Words that label a phone number when they sit right in front of digits. */
const PHONE_WORD_RE = /(?:tel|telefoon|telephone|call|calls|bellen|bel)\b[:\s]*$/i;

const CURRENCY_BEFORE_RE = /(?:[$€£¥]|\b(?:USD|EUR|GBP|CHF|CAD))\s*$/i;
const CURRENCY_AFTER_RE = /^\s?(?:USD|EUR|GBP|CHF|CAD)\b/i;

// Digit candidates: 4–8 digits, or two 2–6 digit halves split once by a single
// space or dash (total 4–8 digits after stripping). The lookbehinds reject the
// tail of a longer spaced/dashed run (phones, thousands groups, ISO dates), a
// decimal or version fragment, and "(0xx) " phone prefixes; the lookaheads
// reject the head of another group, a decimal tail and alphanumeric runs.
const DIGIT_CANDIDATE_RE =
	/(?<![\p{L}\d])(?<!\d[ -])(?<!\d[.,/])(?<!\)\s)(\d{2,6}[ ]\d{2,6}|\d{2,6}-\d{2,6}|\d{4,8})(?![\p{L}\d])(?![ -]\d)(?![.,/]\d)/gu;
// Alphanumeric candidates: 6–8 letters and digits (both required). Codes with a
// lowercase letter must also pass hasStrictAlnumContext.
const ALNUM_CANDIDATE_RE = /(?<![\p{L}\d])([A-Za-z0-9]{6,8})(?![\p{L}\d])/gu;
/** A keyword directly in front, as in "code: b77f3a" or "passcode is b77f3a". */
const KEYWORD_DIRECTLY_BEFORE_RE = new RegExp(`${KEYWORD_SOURCE}(?:\\s+is)?\\s*[:：]?\\s*$`, "i");

function collectCandidates(source: string): CodeCandidate[] {
	const candidates: CodeCandidate[] = [];
	for (const match of source.matchAll(DIGIT_CANDIDATE_RE)) {
		const raw = match[1];
		const index = match.index ?? 0;
		const value = raw.replace(/[ -]/g, "");
		if (value.length < 4 || value.length > 8) continue;
		candidates.push({ value, index, end: index + raw.length, kind: "digits" });
	}
	for (const match of source.matchAll(ALNUM_CANDIDATE_RE)) {
		const raw = match[1];
		const index = match.index ?? 0;
		if (!/[0-9]/.test(raw) || !/[A-Za-z]/.test(raw)) continue;
		candidates.push({ value: raw, index, end: index + raw.length, kind: "alnum" });
	}
	return candidates.sort((a, b) => a.index - b.index);
}

function isPlausibleYear(value: string): boolean {
	return value.length === 4 && /^(?:19|20)\d\d$/.test(value);
}

function sliceBefore(source: string, candidate: CodeCandidate, window: number): string {
	return source.slice(Math.max(0, candidate.index - window), candidate.index);
}

function hasKeywordNear(source: string, candidate: CodeCandidate): boolean {
	if (KEYWORD_RE.test(sliceBefore(source, candidate, KEYWORD_BEFORE_WINDOW))) return true;
	return KEYWORD_RE.test(source.slice(candidate.end, candidate.end + KEYWORD_AFTER_WINDOW));
}

/** Plausible years need a keyword directly in front, not just anywhere nearby. */
function hasTightKeywordBefore(source: string, candidate: CodeCandidate): boolean {
	return KEYWORD_RE.test(sliceBefore(source, candidate, YEAR_KEYWORD_WINDOW));
}

function hasDateContext(source: string, candidate: CodeCandidate): boolean {
	const from = Math.max(0, candidate.index - DATE_CONTEXT_WINDOW);
	return DATE_WORD_RE.test(source.slice(from, candidate.end + DATE_CONTEXT_WINDOW));
}

function hasPhoneContext(source: string, candidate: CodeCandidate): boolean {
	const before = source[candidate.index - 1];
	if (before === "+" || before === "#") return true;
	return PHONE_WORD_RE.test(sliceBefore(source, candidate, 12));
}

function hasCurrencyContext(source: string, candidate: CodeCandidate): boolean {
	if (CURRENCY_BEFORE_RE.test(sliceBefore(source, candidate, 8))) return true;
	return CURRENCY_AFTER_RE.test(source.slice(candidate.end, candidate.end + 8));
}

const URL_MARKER_GLOBAL_RE = /:\/\/|www\./gi;

/**
 * The whitespace-delimited tokens of the source that contain a URL marker, found in one pass. Scanning out from
 * each candidate instead costs the token's length per candidate, which is quadratic on one long token full of
 * candidates.
 */
function findUrlTokenRanges(source: string): UrlTokenRanges {
	const ranges: UrlTokenRanges = [];
	for (const match of source.matchAll(URL_MARKER_GLOBAL_RE)) {
		const index = match.index ?? 0;
		const last = ranges.at(-1);
		if (last && index < last[1]) continue;
		let start = index;
		while (start > 0 && !/\s/.test(source[start - 1])) start--;
		let end = index + match[0].length;
		while (end < source.length && !/\s/.test(source[end])) end++;
		ranges.push([start, end]);
	}
	return ranges;
}

/**
 * True when the candidate sits inside a whitespace-delimited URL token. A split digit candidate ("12 34") spans two
 * tokens, and either one being a URL counts.
 */
function insideUrlToken(urlTokens: UrlTokenRanges, candidate: CodeCandidate): boolean {
	let low = 0;
	let high = urlTokens.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (urlTokens[middle][1] <= candidate.index) low = middle + 1;
		else high = middle;
	}
	return low < urlTokens.length && urlTokens[low][0] < candidate.end;
}

/**
 * True when the word closest before the candidate is a number label (order,
 * invoice, reference…) rather than an OTP keyword, so the digits are that
 * number instead of a code.
 */
function labelBeatsKeyword(source: string, candidate: CodeCandidate): boolean {
	const window = sliceBefore(source, candidate, LABEL_WINDOW);
	const labels = [...window.matchAll(LABEL_GLOBAL_RE)];
	if (!labels.length) return false;
	const keywords = [...window.matchAll(KEYWORD_GLOBAL_RE)];
	if (!keywords.length) return true;
	const lastLabelEnd = Math.max(...labels.map((match) => (match.index ?? 0) + match[0].length));
	const lastKeywordEnd = Math.max(...keywords.map((match) => (match.index ?? 0) + match[0].length));
	return lastLabelEnd > lastKeywordEnd;
}

/**
 * True when only whitespace sits between the candidate and the ends of its line. It walks whitespace only, so it
 * stops at the first other character instead of slicing a line that may be the whole body.
 */
function fillsOwnLine(source: string, candidate: CodeCandidate): boolean {
	for (let index = candidate.index - 1; index >= 0 && source[index] !== "\n"; index--) {
		if (!/\s/.test(source[index])) return false;
	}
	for (let index = candidate.end; index < source.length && source[index] !== "\n"; index++) {
		if (!/\s/.test(source[index])) return false;
	}
	return true;
}

/** True when the candidate fills its own line or an OTP keyword sits directly in front of it. */
function hasStrongPosition(source: string, candidate: CodeCandidate): boolean {
	if (fillsOwnLine(source, candidate)) return true;
	return KEYWORD_DIRECTLY_BEFORE_RE.test(sliceBefore(source, candidate, KEYWORD_BEFORE_WINDOW));
}

function isValidCandidate(source: string, urlTokens: UrlTokenRanges, candidate: CodeCandidate): boolean {
	if (candidate.kind === "digits" && SERVICE_NUMBER_RE.test(candidate.value)) return false;
	// Lowercase letter-digit runs also appear in commit hashes, usernames and
	// product names, so they need a strong position.
	if (candidate.kind === "alnum" && /[a-z]/.test(candidate.value) && !hasStrongPosition(source, candidate)) {
		return false;
	}
	if (hasPhoneContext(source, candidate) || hasCurrencyContext(source, candidate)) return false;
	if (insideUrlToken(urlTokens, candidate)) return false;
	if (labelBeatsKeyword(source, candidate)) return false;
	if (isPlausibleYear(candidate.value)) {
		return !hasDateContext(source, candidate) && hasTightKeywordBefore(source, candidate);
	}
	return hasKeywordNear(source, candidate);
}

/**
 * The distinct valid candidate values of one span, or null when the span has no
 * valid candidate. When some valid candidates are in a strong position, only
 * those count, so a code on its own line is not made ambiguous by a street
 * number in the footer that happens to sit near "The code will expire".
 */
function uniqueValidValues(source: string, urlTokens: UrlTokenRanges, candidates: CodeCandidate[]): Set<string> | null {
	const valid = candidates.filter((candidate) => isValidCandidate(source, urlTokens, candidate));
	if (!valid.length) return null;
	const strong = valid.filter((candidate) => hasStrongPosition(source, candidate));
	return new Set((strong.length ? strong : valid).map((candidate) => candidate.value));
}

/** One value is the code; several different values are ambiguous, which means no code. */
function singleValueOrNull(values: Set<string>): string | null {
	if (values.size > 1) return null;
	return [...values][0] ?? null;
}

/**
 * Text converted from an HTML-only email keeps the markup's indentation, so a keyword and its code can sit
 * over 100 characters of spaces apart. Trimming lines and collapsing runs keeps the windows measuring words.
 */
function compactWhitespace(value: string): string {
	return value
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

/** The one-time code a new email contains, or null when there is none or it is ambiguous. */
export function extractOneTimeCode({ subject, text }: OneTimeCodeInput): string | null {
	const subjectText = typeof subject === "string" ? compactWhitespace(subject) : "";
	const bodyText = typeof text === "string" ? compactWhitespace(text) : "";
	// Candidates live in one concatenated source so a subject keyword sits next
	// to a body that is only the code ("Verification code\n554108").
	const source = subjectText ? `${subjectText}\n${bodyText}` : bodyText;
	if (source.length > MAX_ONE_TIME_CODE_SOURCE_LENGTH || !source.trim()) return null;
	const candidates = collectCandidates(source);
	if (!candidates.length) return null;
	const urlTokens = findUrlTokenRanges(source);
	const subjectEnd = subjectText ? subjectText.length + 1 : 0;
	const subjectValues = uniqueValidValues(
		source,
		urlTokens,
		candidates.filter((candidate) => candidate.index < subjectEnd),
	);
	if (subjectValues) return singleValueOrNull(subjectValues);
	const bodyValues = uniqueValidValues(
		source,
		urlTokens,
		candidates.filter((candidate) => candidate.index >= subjectEnd),
	);
	return bodyValues ? singleValueOrNull(bodyValues) : null;
}
