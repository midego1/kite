import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, routingRules } from "@/db/schema";
import { canManageDomains } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";

export type DomainRuleInput = {
	domainId: string;
	name?: string | null;
	enabled: boolean;
	matchField: "recipient" | "sender" | "title" | "content";
	matchOperator: "contains" | "exact" | "starts_with" | "ends_with" | "regex";
	matchValue: string;
	action: "store" | "forward" | "reject";
	mailboxId?: string | null;
	forwardTo?: string | null;
	keepCopy: boolean;
	rejectReason?: string | null;
	priority: number;
};

export async function listDomainRules(db: AppDatabase, domainId: string) {
	return db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.domainId, domainId), eq(routingRules.scope, "domain")))
		.orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
}

/**
 * Domain rules affect every address on the domain (a reject rule runs before any mailbox
 * lookup), so only an admin who may manage the domain can read or change them.
 */
export const DOMAIN_RULES_ADMIN_ONLY = "Only an admin who can manage this domain can manage domain routing";

type DomainRuleUser = Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "canManageDomains" | "createdByUserId">;

/** An admin the primary admin granted domain management manages the primary's domains as well as its own. */
function domainOwnerIds(user: DomainRuleUser): string[] {
	return !user.isPrimaryAdmin && user.createdByUserId ? [user.id, user.createdByUserId] : [user.id];
}

export async function getAdminDomain(db: AppDatabase, user: DomainRuleUser, domainId: string) {
	if (!canManageDomains(user)) return null;
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), inArray(domains.userId, domainOwnerIds(user))))
		.limit(1);
	return domain ?? null;
}

/** The domains whose routing the user may manage, or null when it may manage none. */
export async function listAdminRoutingDomains(db: AppDatabase, user: DomainRuleUser) {
	if (!canManageDomains(user)) return null;
	return db
		.select({
			id: domains.id,
			hostname: domains.hostname,
			status: domains.status,
			routingEnabled: domains.routingEnabled,
		})
		.from(domains)
		.where(inArray(domains.userId, domainOwnerIds(user)))
		.orderBy(asc(domains.hostname));
}

export async function listAdminDomainMailboxes(db: AppDatabase, domainId: string) {
	return db
		.select({
			id: mailboxes.id,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			disabled: mailboxes.disabled,
		})
		.from(mailboxes)
		.where(eq(mailboxes.domainId, domainId))
		.orderBy(asc(mailboxes.localPart));
}

export async function assertAdminRuleMailbox(db: AppDatabase, mailboxId: string, domainId: string): Promise<boolean> {
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.domainId, domainId)))
		.limit(1);
	return !!mailbox;
}

export function toRuleColumns(input: DomainRuleInput) {
	return {
		scope: "domain" as const,
		name: input.name?.trim() || null,
		enabled: input.enabled,
		pattern: input.matchValue,
		matchField: input.matchField,
		matchOperator: input.matchOperator,
		matchValue: input.matchValue,
		action: input.action,
		mailboxId: input.action === "reject" ? null : (input.mailboxId ?? null),
		folderId: null,
		forwardTo: input.action === "forward" ? (input.forwardTo?.trim() ?? null) : null,
		keepCopy: input.action === "forward" ? input.keepCopy : false,
		rejectReason: input.action === "reject" ? input.rejectReason?.trim() || null : null,
		priority: input.priority,
	};
}
