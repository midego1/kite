// Derived from Mailflare commit 4aaf066 ("feat(import): infer read/spam from message headers", hieunc229/mailflare,
// AGPL-3.0): the header reading, the hint type and `applyImportHints` come from there. Kite parses the headers more
// strictly and takes Gmail's labels as the sole authority on placement.
import type { ImportDestination } from "./destination-types";

/** What a message says about itself. Every field is unset when the headers do not say. */
export type ImportMessageHints = {
	/** From mbox `Status: R`, or a Gmail Takeout export lacking the `Unread` label. */
	read?: boolean;
	/** From Gmail's `Starred` label or mbox `X-Status: F`. */
	starred?: boolean;
	/** Set only when the message itself says it belongs in spam or trash. */
	section?: "spam" | "trash";
};

/** Only the head of a message is read, however large the upload. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_VALUE = 4096;
const MAX_LABELS = 100;
/** `Status` and `X-Status` hold mbox flag letters (`RO`, `AF`: Read, Old, Answered, Deleted, Flagged, Draft). */
const STATUS_VALUE = /^[ROADFT]{1,8}$/;
/** Labels Gmail's own export writes, so a list containing one is a list worth trusting about `Unread`. */
const SYSTEM_LABELS = new Set(["inbox", "sent", "drafts", "starred", "important", "spam", "trash", "opened"]);

/** The header block (up to the first blank line, capped), with folded lines joined. */
function readHeaderBlock(raw: ArrayBuffer): string {
	const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, MAX_HEADER_BYTES));
	let end = bytes.length;
	let terminated = false;
	for (let index = 0; index + 1 < bytes.length; index += 1) {
		if (bytes[index] === 10 && (bytes[index + 1] === 10 || (bytes[index + 1] === 13 && bytes[index + 2] === 10))) {
			end = index;
			terminated = true;
			break;
		}
	}
	// A block cut by the cap ends mid-line: leave that line out rather than read half a header.
	if (!terminated && raw.byteLength > MAX_HEADER_BYTES) end = Math.max(bytes.lastIndexOf(10), 0);
	return new TextDecoder().decode(bytes.subarray(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

/** Every value of the header `name` (case-insensitive), trimmed and capped. A message may repeat a header. */
function headerValues(block: string, name: string): string[] {
	const wanted = name.toLowerCase();
	const values: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon > 0 && line.slice(0, colon).toLowerCase() === wanted) {
			values.push(
				line
					.slice(colon + 1)
					.trim()
					.slice(0, MAX_HEADER_VALUE),
			);
		}
	}
	return values;
}

/** The letters of the mbox status headers, or null when none of the given headers holds a status. */
function statusFlags(block: string, name: string): string | null {
	const values = headerValues(block, name).filter((value) => STATUS_VALUE.test(value));
	return values.length ? values.join("").toUpperCase() : null;
}

/**
 * @public Exercised by the unit tests. `X-Gmail-Labels` is comma-separated and quotes a label that contains a comma.
 * Labels are lower-cased, at most 100. `complete` is false when the list may be cut short (the value hit the length
 * cap, there are more labels than kept, or a quote is left open), so a label's absence says nothing.
 */
export function parseGmailLabelHeader(value: string): { labels: string[]; complete: boolean } {
	const labels: string[] = [];
	let current = "";
	let quoted = false;
	for (const char of value) {
		if (char === '"') {
			quoted = !quoted;
		} else if (char === "," && !quoted) {
			labels.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	labels.push(current);
	const named = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
	return {
		labels: named.slice(0, MAX_LABELS),
		complete: !quoted && named.length <= MAX_LABELS && value.length < MAX_HEADER_VALUE,
	};
}

/**
 * Exports carry their own state: mbox `Status`/`X-Status`, Gmail Takeout labels and spam-filter verdicts. Used where
 * the upload gave no per-message flags. Headers are untrusted, so anything unexpected is ignored.
 */
export function getImportMessageHints(raw: ArrayBuffer): ImportMessageHints {
	const hints: ImportMessageHints = {};
	const block = readHeaderBlock(raw);

	const status = statusFlags(block, "Status");
	const extraStatus = statusFlags(block, "X-Status");
	if (status !== null || extraStatus !== null) hints.read = `${status ?? ""}${extraStatus ?? ""}`.includes("R");
	if (extraStatus?.includes("F")) hints.starred = true;

	// Takeout writes its own label header first; later ones come from the sender and are not read.
	const [labelHeader] = headerValues(block, "X-Gmail-Labels");
	if (labelHeader !== undefined) {
		const { labels: list, complete } = parseGmailLabelHeader(labelHeader);
		const labels = new Set(list);
		// Only a positive signal makes mail read: the `Opened` label, or Gmail's own labels without `Unread`. A list
		// of localized names, or one that may be cut short, says nothing.
		if (labels.has("unread")) hints.read = false;
		else if (labels.has("opened")) hints.read = true;
		else if (complete && list.some((label) => SYSTEM_LABELS.has(label) || label.startsWith("category "))) {
			hints.read = true;
		}
		if (labels.has("starred")) hints.starred = true;
		if (labels.has("trash")) hints.section = "trash";
		else if (labels.has("spam")) hints.section = "spam";
	} else if (headerValues(block, "X-Spam-Flag").some((value) => /^yes\b/i.test(value))) {
		// Gmail's labels are the sole authority on placement; a spam filter's verdict counts only without them.
		hints.section = "spam";
	}
	return hints;
}

/**
 * A hint only refines the default destination: mail uploaded to the Inbox goes to spam or trash when it says so.
 * A section or folder the user picked is kept, as is every destination of the IMAP flow (which files by server
 * labels, not by these headers).
 */
export function applyImportHints(destination: ImportDestination, hints: ImportMessageHints): ImportDestination {
	if (hints.section && destination.type === "system" && destination.section === "inbox") {
		return { type: "system", section: hints.section };
	}
	return destination;
}
