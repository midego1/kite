import { eq, and, asc, desc } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { assistantAddresses } from "@/db/schema/assistant-email";
import { domains, folders, mailboxAliases, mailboxes, routingRules } from "@/db/schema";
import { selectRow } from "@/lib/db/pending-columns";
import { getEmailAddress } from "@/lib/email/address";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { normalizeRecipientLocalPart, parseRecipientAddress } from "@/lib/email/recipient-address";

export type ResolvedMailbox = {
	mailboxId: string;
	folderId: string | null;
	userId: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
};

export type RoutingDecision = {
	action: "store" | "forward" | "reject" | "assistant";
	mailbox?: ResolvedMailbox;
	forwardTo?: string;
	/** Forward rules drop the message unless the rule also keeps a copy in the mailbox. */
	keepCopy?: boolean;
	rejectReason?: string;
	/** Set when a domain-scope rule produced this decision, so the caller can record a match. */
	ruleId?: string;
	/** Set only for `action: "assistant"` (docs/specs/assistant-by-email.md §4): which address matched. */
	assistantAddressId?: string;
};

export type InboxRuleDestination = {
	status: "received" | "spam" | "trash";
	folderId: string | null;
};

type RuleRow = typeof routingRules.$inferSelect;

export type RuleMatchInput = {
	toAddress: string;
	fromAddress?: string | null;
	subject?: string | null;
	content?: string | null;
};

/**
 * Resolves what should happen to an inbound message addressed to `toAddress`.
 *
 * Domain-scope rules are evaluated in three phases so that a broad catch-all can never
 * shadow a real mailbox:
 *   1. `reject` rules (block lists) — highest precedence, evaluated before delivery.
 *   2. exact mailbox, then multi-domain mailbox aliases.
 *   3. remaining `forward` / `store` rules — the catch-all fallback.
 * Within each phase rules run by descending priority, then oldest first.
 */
export async function resolveInboundAddress(
	db: AppDatabase,
	toAddress: string,
	fromAddress?: string | null,
): Promise<RoutingDecision | null> {
	const parsed = parseRecipientAddress(toAddress);
	if (!parsed) return null;

	const domain = await selectRow(db, domains, and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")));

	if (!domain) return null;

	const domainRules = await listDomainRules(db, domain.id);
	const matchInput: RuleMatchInput = { toAddress, fromAddress };

	// Phase 1 — block rules run before any mailbox lookup so they can block a sender
	// even when the recipient is a real mailbox.
	for (const rule of domainRules) {
		if (rule.action !== "reject") continue;
		if (!matchesRule(rule, matchInput)) continue;
		return {
			action: "reject",
			rejectReason: rule.rejectReason?.trim() || "Message rejected by routing rule",
			ruleId: rule.id,
		};
	}

	// Phase 2 — a real mailbox always wins over a catch-all.
	const mailbox = await findAddressMailbox(db, domain.id, parsed);

	if (mailbox) {
		return {
			action: "store",
			mailbox: toResolvedMailbox(mailbox, domain.id, domain.hostname),
		};
	}

	// Still phase 2: an assistant address (docs/specs/assistant-by-email.md §10) can never collide with a
	// mailbox or alias (checked when either is created), so this order never matters for correctness.
	const assistantAddressId = await findAssistantAddressId(db, domain.id, parsed.localPart);
	if (assistantAddressId) {
		return { action: "assistant", assistantAddressId };
	}

	// Phase 3 — catch-all and forwarding fallbacks.
	for (const rule of domainRules) {
		if (rule.action !== "forward" && rule.action !== "store") continue;
		if (!matchesRule(rule, matchInput)) continue;

		if (rule.action === "forward") {
			const forwardTo = rule.forwardTo?.trim();
			if (!forwardTo) continue;
			const catchAll = rule.mailboxId ? await getRuleMailbox(db, rule.mailboxId, domain.id) : null;
			return {
				action: "forward",
				forwardTo,
				keepCopy: rule.keepCopy && !!catchAll,
				mailbox: catchAll ?? undefined,
				ruleId: rule.id,
			};
		}

		if (!rule.mailboxId) continue;
		const catchAll = await getRuleMailbox(db, rule.mailboxId, domain.id);
		if (!catchAll) continue;
		return { action: "store", mailbox: catchAll, ruleId: rule.id };
	}

	return null;
}

/** The mailbox an address on `domainId` delivers to: exact mailbox, then alias, then use-all-domains mailbox. */
async function findAddressMailbox(
	db: AppDatabase,
	domainId: string,
	parsed: { localPart: string; normalizedAddress: string },
) {
	const exactMailboxes = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domainId), eq(mailboxes.disabled, false)));
	return (
		exactMailboxes.find((mailbox) => normalizeRecipientLocalPart(mailbox.localPart) === parsed.localPart) ??
		(await resolveMailboxAlias(db, domainId, parsed.localPart)) ??
		(await resolveMailboxDomainAlias(db, parsed.localPart, parsed.normalizedAddress))
	);
}

/**
 * Whether inbound mail for `address` already reaches a mailbox, matched the way delivery
 * resolves it (dots and `+tags` ignored, use-all-domains mailboxes included).
 */
export async function isAddressDelivered(db: AppDatabase, domainId: string, address: string): Promise<boolean> {
	const parsed = parseRecipientAddress(address);
	return !parsed || !!(await findAddressMailbox(db, domainId, parsed));
}

/**
 * Whether `hostname` is a domain of this install, whatever its status. A verified extra sender address
 * (spec §5.3) must never be one of ours: a shared mailbox on one of our own domains would let anyone who can
 * send as it verify its address as their own "extra" sender and so command another user's assistant. The same
 * check `assertNotKiteDomain` makes for connecting an external account.
 */
export async function isInstallDomain(db: AppDatabase, hostname: string): Promise<boolean> {
	const [domain] = await db
		.select({ id: domains.id })
		.from(domains)
		.where(eq(domains.hostname, hostname.trim().toLowerCase()))
		.limit(1);
	return !!domain;
}

/** A personal mailbox's own id and owner. */
type OwnMailbox = { mailboxId: string; userId: string };

/**
 * The personal mailbox whose own address is exactly `address` (already lower-cased; dots and `+tags` are never
 * folded), or null. Unlike `findAddressMailbox` (receiving, which folds dots and `+tags` the way delivery does so
 * a tagged variant still reaches the right inbox), this is for deciding *whose* request a message is — spec
 * §5.3 keeps the From address written exactly, because anyone who can create a mailbox or alias on a domain the
 * owner's assistant uses could otherwise send as `owner+x@domain` and have it fold onto the owner's own mailbox.
 * A shared mailbox never matches here (several people can send as it), and a disabled one never matches either.
 */
export async function findSenderMailbox(
	db: AppDatabase,
	domainId: string,
	hostname: string,
	address: string,
): Promise<OwnMailbox | null> {
	const at = address.lastIndexOf("@");
	if (at <= 0) return null;
	const localPart = address.slice(0, at);

	const [exact] = await db
		.select({ mailboxId: mailboxes.id, userId: mailboxes.userId })
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.domainId, domainId),
				eq(mailboxes.localPart, localPart),
				eq(mailboxes.type, "personal"),
				eq(mailboxes.disabled, false),
			),
		)
		.limit(1);
	if (exact) return exact;

	const [viaAlias] = await db
		.select({ mailboxId: mailboxes.id, userId: mailboxes.userId })
		.from(mailboxAliases)
		.innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
		.where(
			and(
				eq(mailboxAliases.domainId, domainId),
				eq(mailboxAliases.localPart, localPart),
				eq(mailboxes.type, "personal"),
				eq(mailboxes.disabled, false),
			),
		)
		.limit(1);
	if (viaAlias) return viaAlias;

	// A use-all-domains mailbox answers on every active domain of its owner; `getMailboxDomainAddresses` already
	// returns its exact addresses (primary, aliases, every assigned domain), none of them folded.
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)));
	for (const mailbox of candidates) {
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		if (addresses.includes(address)) return { mailboxId: mailbox.id, userId: mailbox.userId };
	}
	return null;
}

/**
 * The enabled assistant address on `domainId` matching `localPart`, or null. Missing-table-safe (migration 0096
 * may not be applied yet), unlike the pending-columns case elsewhere in this file: before the migration the whole
 * table is absent, so mail simply has no assistant address to match, exactly as before this feature existed.
 */
async function findAssistantAddressId(db: AppDatabase, domainId: string, localPart: string): Promise<string | null> {
	try {
		const rows = await db
			.select({ id: assistantAddresses.id, localPart: assistantAddresses.localPart })
			.from(assistantAddresses)
			.where(and(eq(assistantAddresses.domainId, domainId), eq(assistantAddresses.enabled, true)));
		return rows.find((row) => normalizeRecipientLocalPart(row.localPart) === localPart)?.id ?? null;
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

/**
 * Whether `localPart` on `domainId` is already an assistant address (any status), so mailbox and alias creation,
 * and creating another assistant address, can refuse a colliding local part in either direction (§10, §13).
 */
export async function isAssistantAddressTaken(db: AppDatabase, domainId: string, localPart: string): Promise<boolean> {
	try {
		const rows = await db
			.select({ localPart: assistantAddresses.localPart })
			.from(assistantAddresses)
			.where(eq(assistantAddresses.domainId, domainId));
		const normalized = normalizeRecipientLocalPart(localPart);
		return rows.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized);
	} catch (error) {
		if (isNoSuchTableError(error)) return false;
		throw error;
	}
}

async function listDomainRules(db: AppDatabase, domainId: string): Promise<RuleRow[]> {
	return db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.domainId, domainId), eq(routingRules.scope, "domain"), eq(routingRules.enabled, true)))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

async function getRuleMailbox(db: AppDatabase, mailboxId: string, domainId: string): Promise<ResolvedMailbox | null> {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.disabled, false)))
		.limit(1);
	if (!mailbox) return null;

	const [domain] = await db
		.select({ hostname: domains.hostname })
		.from(domains)
		.where(eq(domains.id, domainId))
		.limit(1);
	if (!domain) return null;

	return toResolvedMailbox(mailbox, domainId, domain.hostname);
}

function toResolvedMailbox(
	mailbox: typeof mailboxes.$inferSelect,
	domainId: string,
	hostname: string,
): ResolvedMailbox {
	return {
		mailboxId: mailbox.id,
		folderId: null,
		userId: mailbox.userId,
		domainId,
		localPart: mailbox.localPart,
		hostname,
		displayName: mailbox.displayName,
	};
}

/** Records that a domain rule fired, for the "last matched" column in the routing UI. */
export async function recordRuleMatch(db: AppDatabase, ruleId: string): Promise<void> {
	const [rule] = await db
		.select({ matchCount: routingRules.matchCount })
		.from(routingRules)
		.where(eq(routingRules.id, ruleId))
		.limit(1);
	if (!rule) return;
	await db
		.update(routingRules)
		.set({ matchCount: rule.matchCount + 1, lastMatchedAt: new Date() })
		.where(eq(routingRules.id, ruleId));
}

async function resolveMailboxAlias(db: AppDatabase, domainId: string, localPart: string) {
	const rows = await db
		.select({ mailbox: mailboxes, aliasLocalPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.innerJoin(mailboxes, eq(mailboxAliases.mailboxId, mailboxes.id))
		.where(and(eq(mailboxAliases.domainId, domainId), eq(mailboxes.disabled, false)));
	const row = rows.find((item) => normalizeRecipientLocalPart(item.aliasLocalPart) === localPart);
	return row?.mailbox ?? null;
}

async function resolveMailboxDomainAlias(db: AppDatabase, localPart: string, normalizedAddress: string) {
	const candidates = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.useAllDomains, true), eq(mailboxes.disabled, false)));

	for (const mailbox of candidates) {
		if (normalizeRecipientLocalPart(mailbox.localPart) !== localPart) continue;
		const addresses = await getMailboxDomainAddresses(db, mailbox);
		if (addresses.some((address) => parseRecipientAddress(address)?.normalizedAddress === normalizedAddress)) {
			return mailbox;
		}
	}
	return null;
}

export async function resolveInboxRuleDestination(
	db: AppDatabase,
	input: {
		mailboxId: string;
		toAddress: string;
		fromAddress?: string | null;
		subject?: string | null;
		content?: string | null;
	},
): Promise<InboxRuleDestination> {
	const rules = await db
		.select()
		.from(routingRules)
		.where(
			and(
				eq(routingRules.mailboxId, input.mailboxId),
				eq(routingRules.scope, "mailbox"),
				eq(routingRules.enabled, true),
			),
		)
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));

	for (const rule of rules) {
		if (!matchesRule(rule, input)) continue;

		if (rule.action === "spam" || rule.action === "trash") {
			return { status: rule.action, folderId: null };
		}

		if (!rule.folderId) continue;
		const folderId = await getRuleFolderId(db, rule.folderId, input.mailboxId);
		if (!folderId) continue;
		return { status: "received", folderId };
	}

	return { status: "received", folderId: null };
}

type MatchableRule = {
	pattern: string;
	matchField?: string | null;
	matchOperator?: string | null;
	matchValue?: string | null;
};

export function matchesRule(rule: MatchableRule, input: RuleMatchInput): boolean {
	const rawValue = (rule.matchValue || rule.pattern).trim();
	// "*" is the catch-all pattern used by catch-all and block-everything rules.
	if (rawValue === "*") return true;
	const normalizedRuleValue = normalizeRuleComparisonValue(rule.matchField, rawValue);
	if (!normalizedRuleValue) return false;

	const values = getRuleFieldValues(rule.matchField, input);
	return values.some((value) => {
		if (!value) return false;
		const normalizedValue = normalizeRuleComparisonValue(rule.matchField, value);
		if (!normalizedValue) return false;
		return compareRuleValue(rule.matchOperator, normalizedValue, normalizedRuleValue, rawValue);
	});
}

function compareRuleValue(
	operator: string | null | undefined,
	value: string,
	ruleValue: string,
	rawRuleValue: string,
): boolean {
	switch (operator) {
		case "exact":
			return value === ruleValue;
		case "starts_with":
			return value.startsWith(ruleValue);
		case "ends_with":
			return value.endsWith(ruleValue);
		case "regex":
			return matchesRegex(value, rawRuleValue);
		default:
			return value.includes(ruleValue);
	}
}

/**
 * Rule patterns are operator-authored but still untrusted enough to warrant guarding:
 * an invalid pattern must not throw and take down inbound processing.
 */
function matchesRegex(value: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(value);
	} catch {
		return false;
	}
}

function normalizeRuleComparisonValue(field: string | null | undefined, value: string | null | undefined): string {
	if (!value) return "";
	if (field === "email" || field === "sender" || field === "recipient") {
		return getEmailAddress(value).trim().toLowerCase();
	}
	return value.toLowerCase();
}

function getRuleFieldValues(field: string | null | undefined, input: RuleMatchInput) {
	if (field === "content") return [input.content];
	if (field === "title") return [input.subject];
	if (field === "sender") return [input.fromAddress];
	if (field === "recipient") return [input.toAddress];
	return [input.fromAddress, input.toAddress];
}

async function getRuleFolderId(db: AppDatabase, folderId: string, mailboxId: string): Promise<string | null> {
	const [folder] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder?.id ?? null;
}
