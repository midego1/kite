import { getEmailAddress, normalizeEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import type {
	ScreenerDecision,
	ScreenerMode,
	ScreenerSenderRemoval,
	ScreenerSenderRequest,
	ScreenerSettings,
	ScreenerSettingsPatch,
	ScreenerVerdict,
} from "./screener-types";

/** The message status of mail held in the Screener. Every Inbox, folder, search and count query leaves it out. */
export const SCREENING_STATUS = "screening";

const SCREENER_MODES: readonly ScreenerMode[] = ["screener", "inbox"];

/** How many released or denied messages one decision trains on or schedules automatic reading for. */
export const SCREENER_FOLLOW_UP_LIMIT = 25;

const ADDRESS_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function isScreenerMode(value: unknown): value is ScreenerMode {
	return typeof value === "string" && (SCREENER_MODES as readonly string[]).includes(value);
}

function isScreenerDecision(value: unknown): value is ScreenerDecision {
	return value === "approved" || value === "denied";
}

/** The lowercased bare address of a sender or header value, or null when it is not one address. */
export function screenerAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const address = normalizeEmailAddress(getEmailAddress(value.trim()));
	return ADDRESS_PATTERN.test(address) ? address : null;
}

/**
 * What delivery does with a message. Only mail that would land in the Inbox or a user folder (`received`) is
 * screened: spam, trash and rule-filed archive keep their status, so the spam filter and rules always run first.
 */
export function screenerVerdict(input: {
	settings: ScreenerSettings | null;
	status: string;
	sender: string | null;
	decision: ScreenerDecision | null;
}): ScreenerVerdict {
	if (!input.settings?.enabled || input.status !== "received" || !input.sender) return "deliver";
	if (input.decision === "approved") return "deliver";
	if (input.decision === "denied") return "spam";
	return input.settings.mode === "inbox" ? "mark" : "hold";
}

/** Every distinct address a sent message went to, across To, Cc and Bcc. */
export function recipientAddresses(...lists: (string | string[] | null | undefined)[]): string[] {
	const addresses = new Set<string>();
	for (const list of lists) {
		const entries = Array.isArray(list)
			? list.flatMap((item) => splitEmailAddressList(item))
			: splitEmailAddressList(list);
		for (const entry of entries) {
			const address = screenerAddress(entry);
			if (address) addresses.add(address);
		}
	}
	return [...addresses];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function record(body: unknown): Record<string, unknown> | null {
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function parseScreenerSettingsPatch(body: unknown): Parsed<ScreenerSettingsPatch & { mailboxId: string }> {
	const input = record(body);
	if (!input || typeof input.mailboxId !== "string" || !input.mailboxId)
		return { ok: false, error: "Mailbox is required" };
	const patch: ScreenerSettingsPatch = {};
	if (input.enabled !== undefined) {
		if (typeof input.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
		patch.enabled = input.enabled;
	}
	if (input.mode !== undefined) {
		if (!isScreenerMode(input.mode)) return { ok: false, error: "mode must be screener or inbox" };
		patch.mode = input.mode;
	}
	if (patch.enabled === undefined && patch.mode === undefined) return { ok: false, error: "No changes requested" };
	return { ok: true, value: { mailboxId: input.mailboxId, ...patch } };
}

export function parseScreenerSenderRequest(body: unknown): Parsed<ScreenerSenderRequest> {
	const input = record(body);
	if (!input || typeof input.mailboxId !== "string" || !input.mailboxId)
		return { ok: false, error: "Mailbox is required" };
	const address = screenerAddress(input.address);
	if (!address) return { ok: false, error: "Enter one email address" };
	if (!isScreenerDecision(input.decision)) return { ok: false, error: "decision must be approved or denied" };
	return { ok: true, value: { mailboxId: input.mailboxId, address, decision: input.decision } };
}

export function parseScreenerSenderRemoval(body: unknown): Parsed<ScreenerSenderRemoval> {
	const input = record(body);
	if (!input || typeof input.mailboxId !== "string" || !input.mailboxId)
		return { ok: false, error: "Mailbox is required" };
	const address = screenerAddress(input.address);
	if (!address) return { ok: false, error: "Enter one email address" };
	const restore = Array.isArray(input.restoreMessageIds) ? input.restoreMessageIds : [];
	return {
		ok: true,
		value: {
			mailboxId: input.mailboxId,
			address,
			restoreMessageIds: [...new Set(restore.filter((id): id is string => typeof id === "string" && !!id))],
		},
	};
}

/** Whether a list row shows the "New sender" mark: undecided inbound mail in an enabled Inbox-mode mailbox. */
export function isNewSenderRow(
	row: { status: string; direction: string; fromAddr: string },
	inboxModeMailbox: boolean,
	decided: ReadonlySet<string>,
): boolean {
	if (row.status === SCREENING_STATUS) return true;
	if (!inboxModeMailbox || row.status !== "received" || row.direction !== "inbound") return false;
	const sender = screenerAddress(row.fromAddr);
	return !!sender && !decided.has(sender);
}
