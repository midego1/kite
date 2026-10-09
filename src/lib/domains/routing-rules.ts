import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, routingRules } from "@/db/schema";
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
 * lookup), so only an admin of the domain may read or change them.
 */
export const DOMAIN_RULES_ADMIN_ONLY = "Only an admin of this domain can manage domain routing";

export async function getAdminDomain(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role" | "canManageMailboxes" | "createdByUserId">,
	domainId: string,
) {
	if (user.role !== "admin") return null;
	const ownerId = user.canManageMailboxes && user.createdByUserId ? user.createdByUserId : user.id;
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, ownerId)))
		.limit(1);
	return domain ?? null;
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
