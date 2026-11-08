import type { Address, Mailbox } from "postal-mime";
import type { EmailAddressParts } from "@/lib/email/address-types";
import { parseAddress } from "@/lib/utils";

function quoteDisplayName(name: string): string {
	return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatEmailAddress(address: string, name?: string | null): string {
	const normalizedAddress = address.trim();
	const normalizedName = name?.trim();

	if (!normalizedName) return normalizedAddress;
	return `${quoteDisplayName(normalizedName)} <${normalizedAddress}>`;
}

/** The index of the first unescaped `"` at or after `start`, skipping `\\X` pairs, or -1. */
function findUnescapedQuote(value: string, start: number): number {
	for (let i = start; i < value.length; i++) {
		if (value[i] === "\\" && i + 1 < value.length) {
			i++;
			continue;
		}
		if (value[i] === '"') return i;
	}
	return -1;
}

/** Reverses `quoteDisplayName`'s escaping: `\"` to `"`, `\\` to `\`. */
function unescapeDisplayName(name: string): string {
	let result = "";
	for (let i = 0; i < name.length; i++) {
		if (name[i] === "\\" && i + 1 < name.length) {
			i++;
			result += name[i];
			continue;
		}
		result += name[i];
	}
	return result;
}

/** `"Name" <addr>` or `Name <addr>`, parsed by index rather than a backtracking regex. */
function parseNameAddr(value: string): EmailAddressParts | null {
	if (!value.endsWith(">")) return null;
	let name: string;
	let rest: string;
	if (value.startsWith('"')) {
		const close = findUnescapedQuote(value, 1);
		if (close <= 1) return null;
		name = unescapeDisplayName(value.slice(1, close));
		rest = value.slice(close + 1).trimStart();
		if (!rest.startsWith("<")) return null;
	} else {
		const open = value.indexOf("<");
		if (open <= 0) return null;
		name = value.slice(0, open);
		if (name.includes('"')) return null;
		rest = value.slice(open);
	}
	const address = rest.slice(1, -1);
	if (!address || address.includes(">")) return null;
	return { name: name.trim() || null, address: address.trim() };
}

export function parseEmailAddressParts(value: string): EmailAddressParts {
	const trimmed = value.trim();
	return parseNameAddr(trimmed) ?? { name: null, address: trimmed };
}

export function getEmailAddress(value: string): string {
	return parseEmailAddressParts(value).address;
}

export function normalizeEmailAddress(value: string): string {
	return getEmailAddress(value).trim().toLowerCase();
}

export function getEmailDisplayName(value: string): string {
	const parts = parseEmailAddressParts(value);
	if (parts.name) return parts.name;

	const parsed = parseAddress(parts.address);
	return parsed?.local || parts.address;
}

export function formatPostalAddress(address: Address | undefined, fallback: string | null): string | null {
	const [mailbox] = getPostalMailboxes(address);
	if (!mailbox?.address) return fallback;

	return formatEmailAddress(mailbox.address, mailbox.name);
}

/**
 * Every mailbox in a header address list, formatted and comma-joined, so that a
 * message's full To/Cc line survives storage and reply-all can see it.
 */
export function formatPostalAddressList(addresses: Address[] | undefined, fallback: string | null): string | null {
	const mailboxes = (addresses ?? []).flatMap(getPostalMailboxes).filter((item) => !!item.address);
	if (mailboxes.length === 0) return fallback;

	return mailboxes.map((mailbox) => formatEmailAddress(mailbox.address, mailbox.name)).join(", ");
}

/** A parsed header value without the whitespace it was folded with: postal-mime keeps runs of it, tabs included. */
export function collapseFoldingSpace(value: string): string {
	return value.replace(/[ \t]+/g, " ");
}

function getPostalMailboxes(address: Address | undefined): Mailbox[] {
	if (!address) return [];
	const mailboxes = "address" in address && address.address ? [address] : (address.group ?? []);
	return mailboxes.map((mailbox) => ({ ...mailbox, name: collapseFoldingSpace(mailbox.name) }));
}

/**
 * Split a comma-separated header value into individual addresses, leaving
 * commas inside quoted display names (`"Chen, Maya" <maya@example.com>`) alone.
 */
export function splitEmailAddressList(value: string | null | undefined): string[] {
	const source = value ?? "";
	const result: string[] = [];
	let current = "";
	let inQuotes = false;
	let inAngle = false;

	for (let i = 0; i < source.length; i++) {
		const char = source[i];

		if (inQuotes && char === "\\" && i + 1 < source.length) {
			current += char + source[i + 1];
			i++;
			continue;
		}

		if (char === '"' && !inAngle) inQuotes = !inQuotes;
		else if (char === "<" && !inQuotes) inAngle = true;
		else if (char === ">" && !inQuotes) inAngle = false;

		if ((char === "," || char === ";") && !inQuotes && !inAngle) {
			if (current.trim()) result.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) result.push(current.trim());
	return result;
}

/** Bare, lower-cased addresses from a header list, deduplicated in order. */
export function getEmailAddressList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of splitEmailAddressList(value)) {
		const address = normalizeEmailAddress(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(address);
	}
	return result;
}

export function joinEmailAddressList(values: string[]): string {
	return values
		.map((value) => value.trim())
		.filter(Boolean)
		.join(", ");
}

/** The first address of a list, for places that show a single party. */
export function getFirstEmailAddressEntry(value: string | null | undefined): string {
	return splitEmailAddressList(value)[0] ?? (value ?? "").trim();
}
