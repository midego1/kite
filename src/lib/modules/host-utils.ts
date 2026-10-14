import { normalizeEmailAddress } from "@/lib/email/address";
import { cleanDisplayText } from "./display-text-utils";
import type { HostActionResult, HostMessageHeaderName, HostNotice, HostRecentFromSenderQuery } from "./host-types";
import type { CapabilityDescriptor, ModuleCapabilities, ModuleId } from "./module-types";
import { isSameOriginPath } from "./path-utils";

/** The most body text `mail.getMessage` hands out, whatever the caller asks for. @public Test-only: used inside this file, exported for tests. */
export const MAX_MESSAGE_TEXT_BYTES = 64 * 1024;
/** Excerpt size of each message `mail.recentFromSender` returns. */
export const RECENT_EXCERPT_BYTES = 4 * 1024;
const MAX_RECENT_MESSAGES = 5;
const MAX_RECENT_DAYS = 1000;
/** Header values are attacker-controlled; anything longer is cut, not dropped. */
const MAX_HEADER_CHARS = 4_096;
const MAX_NOTICE_TITLE_CHARS = 120;
const MAX_NOTICE_BODY_CHARS = 300;
const NOTICE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const HEADER_NAMES: readonly HostMessageHeaderName[] = ["list-unsubscribe", "list-unsubscribe-post", "list-id"];

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, never splitting a character; null when there is no text. */
export function utf8Excerpt(text: string | null | undefined, maxBytes: number): string | null {
	if (!text) return null;
	const limit = Math.max(0, Math.min(Math.floor(maxBytes), MAX_MESSAGE_TEXT_BYTES));
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > limit) break;
		bytes += size;
		end += char.length;
	}
	return end > 0 ? text.slice(0, end) : null;
}

/** The asked-for list headers from a header map (lower-case names), each trimmed and cut, null when absent or empty. */
export function pickMessageHeaders(
	headers: Record<string, string>,
	names: readonly string[],
): Partial<Record<HostMessageHeaderName, string | null>> {
	const picked: Partial<Record<HostMessageHeaderName, string | null>> = {};
	for (const name of HEADER_NAMES) {
		if (!names.includes(name)) continue;
		const value = Object.hasOwn(headers, name) ? headers[name] : undefined;
		picked[name] = typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_HEADER_CHARS) : null;
	}
	return picked;
}

export type RecentBounds = { sender: string; before: Date; since: Date; limit: number };

/** The normalized window of a `recentFromSender` query, or null when the sender or the time is unusable. */
export function recentBounds(query: HostRecentFromSenderQuery): RecentBounds | null {
	const sender = typeof query.sender === "string" ? normalizeEmailAddress(query.sender) : "";
	const before = new Date(query.before);
	if (!sender.includes("@") || Number.isNaN(before.getTime())) return null;
	const days = Number.isFinite(query.sinceDays)
		? Math.min(Math.max(Math.floor(query.sinceDays), 1), MAX_RECENT_DAYS)
		: 1;
	const limit = Number.isFinite(query.limit)
		? Math.min(Math.max(Math.floor(query.limit), 1), MAX_RECENT_MESSAGES)
		: MAX_RECENT_MESSAGES;
	return { sender, before, since: new Date(before.getTime() - days * 86_400_000), limit };
}

/** A LIKE pattern matching any `from` value that contains the address, with LIKE wildcards escaped by `\`. */
export function containsPattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Whether a stored `from` header names exactly this (normalized) address. */
export function isFromSender(fromAddr: string, sender: string): boolean {
	return normalizeEmailAddress(fromAddr) === sender;
}

export type CleanNotice = { notice: string; title: string; body: string | null; href: string | null };

/** The notice as it is sent, or null when its id, title or link is unusable (a link must be a same-origin path). */
export function cleanNotice(notice: HostNotice): CleanNotice | null {
	if (typeof notice?.notice !== "string" || !NOTICE_ID.test(notice.notice)) return null;
	const title = cleanDisplayText(notice.title, MAX_NOTICE_TITLE_CHARS);
	if (!title) return null;
	if (notice.href !== undefined && !isSameOriginPath(notice.href)) return null;
	return {
		notice: notice.notice,
		title,
		body: cleanDisplayText(notice.body, MAX_NOTICE_BODY_CHARS) ?? null,
		href: notice.href ?? null,
	};
}

type ActionDescriptor = CapabilityDescriptor & { action: NonNullable<CapabilityDescriptor["action"]> };

/**
 * The action descriptor a module may execute under `capability`, or why not: 403 when the name is
 * another module's action, 404 when no module declares an action by that name.
 */
export function ownedActionDescriptor(
	all: readonly ModuleCapabilities[],
	moduleId: ModuleId,
	capability: string,
): ActionDescriptor | { status: 403 | 404; error: string } {
	const isAction = (descriptor: CapabilityDescriptor): descriptor is ActionDescriptor =>
		descriptor.name === capability && descriptor.surfaces.includes("action") && !!descriptor.action;
	const own = all.find((entry) => entry.moduleId === moduleId)?.descriptors.find(isAction);
	if (own) return own;
	const foreign = all.some((entry) => entry.moduleId !== moduleId && entry.descriptors.some(isAction));
	return foreign
		? { status: 403, error: "This action belongs to another module" }
		: { status: 404, error: "Unknown action" };
}

/** The host answer for an executor refusal reason: missing permissions are 403, everything else 409. */
export function refusedAction(reason: string | null): HostActionResult {
	const error = reason ?? "The action could not be completed";
	return { ok: false, status: reason?.startsWith("missing_") ? 403 : 409, error };
}
