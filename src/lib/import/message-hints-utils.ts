// The idea of reading a file import's state from the message's own headers comes from Mailflare commit 4aaf066
// ("feat(import): infer read/spam from message headers", hieunc229/mailflare, AGPL-3.0). This is Kite's own
// implementation: it parses the headers defensively and only refines the default Inbox destination.
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
/** `Status` and `X-Status` are a few letters (`RO`, `AF`); anything else is not an mbox status. */
const STATUS_VALUE = /^[A-Za-z]{1,8}$/;

/** The header block (up to the first blank line, capped), with folded lines joined. */
function readHeaderBlock(raw: ArrayBuffer): string {
	const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, MAX_HEADER_BYTES));
	let end = bytes.length;
	for (let index = 0; index + 1 < bytes.length; index += 1) {
		if (bytes[index] === 10 && (bytes[index + 1] === 10 || (bytes[index + 1] === 13 && bytes[index + 2] === 10))) {
			end = index;
			break;
		}
	}
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

/** @public Exercised by the unit tests. `X-Gmail-Labels` is comma-separated and quotes a label that contains a comma. Lower-cased, at most 100. */
export function parseGmailLabelHeader(value: string): string[] {
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
	return labels
		.map((label) => label.trim().toLowerCase())
		.filter(Boolean)
		.slice(0, MAX_LABELS);
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

	const labelHeaders = headerValues(block, "X-Gmail-Labels");
	if (labelHeaders.length) {
		const labels = new Set(labelHeaders.flatMap(parseGmailLabelHeader));
		// A Takeout export lists `Unread` on unread mail only, so a labelled message without it was read.
		hints.read = !labels.has("unread");
		if (labels.has("starred")) hints.starred = true;
		if (labels.has("trash")) hints.section = "trash";
		else if (labels.has("spam")) hints.section = "spam";
	}

	if (!hints.section && headerValues(block, "X-Spam-Flag").some((value) => /^yes\b/i.test(value))) {
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
