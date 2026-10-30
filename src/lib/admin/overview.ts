import { and, count, countDistinct, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, domains, users, webhookDeliveries, webhooks } from "@/db/schema";
import { AI_ERRORS_KEPT } from "@/lib/agent/ai-errors";
import { canManageDomains, isPrimaryAdmin } from "@/lib/auth/admin";
import { domainOwnerId } from "@/lib/domains/owner-utils";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import type { AdminOverviewCounts } from "./overview-types";

/** Webhook failures and AI errors older than this are history, not something to act on. */
const OVERVIEW_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const sum = (condition: ReturnType<typeof sql>) =>
	sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;

/**
 * The numbers behind the tiles, each scoped like the page it opens: accounts as `/api/accounts` lists them (every
 * account), mailboxes as `/api/mailboxes` does (the viewer's own and the shared ones they were given), domains as
 * `/api/domains` does (the owner's), webhooks as `/api/webhooks` does (the viewer's). Counts and a short mailbox
 * list, never the heavy per-mailbox lookups of the mailbox page.
 */
export async function loadAdminOverviewCounts(env: CloudflareEnv, user: SessionUser): Promise<AdminOverviewCounts> {
	const db = getDb(env);
	const primary = isPrimaryAdmin(user);
	const since = new Date(Date.now() - OVERVIEW_RECENT_WINDOW_MS);
	const [accounts, mailboxCounts, domainCounts, webhookCounts, aiErrors] = await Promise.all([
		db
			.select({
				total: count(),
				admins: sum(sql`${users.role} = 'admin'`),
				disabled: sum(sql`${users.disabled} = 1`),
			})
			.from(users)
			.then((rows) => rows[0]),
		listAccessibleMailboxes(db, user).then((rows) => ({
			total: rows.length,
			shared: rows.filter((mailbox) => mailbox.type === "shared").length,
		})),
		canManageDomains(user)
			? db
					.select({ total: count(), active: sum(sql`${domains.status} = 'active'`) })
					.from(domains)
					.where(eq(domains.userId, domainOwnerId(user)))
					.then((rows) => rows[0])
			: null,
		primary
			? db
					.select({ failingHooks: countDistinct(webhookDeliveries.webhookId), recentFailures: count() })
					.from(webhookDeliveries)
					.innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
					.where(
						and(
							eq(webhooks.userId, user.id),
							eq(webhooks.enabled, true),
							inArray(webhookDeliveries.status, ["failed", "exhausted"]),
							gte(webhookDeliveries.lastAttemptAt, since),
						),
					)
					.then((rows) => rows[0])
			: null,
		primary
			? db
					.select({ recent: count() })
					.from(auditLogs)
					.where(and(eq(auditLogs.action, "ai.error"), gte(auditLogs.createdAt, since)))
					.then((rows) => rows[0])
			: null,
	]);
	return {
		accounts: { total: accounts.total, admins: Number(accounts.admins), disabled: Number(accounts.disabled) },
		mailboxes: { total: mailboxCounts.total, shared: Number(mailboxCounts.shared) },
		domains: domainCounts
			? {
					total: domainCounts.total,
					active: Number(domainCounts.active),
					inactive: domainCounts.total - Number(domainCounts.active),
				}
			: null,
		webhooks: webhookCounts
			? { failingHooks: webhookCounts.failingHooks, recentFailures: webhookCounts.recentFailures }
			: null,
		aiErrors: aiErrors ? { recent: aiErrors.recent, capped: aiErrors.recent >= AI_ERRORS_KEPT } : null,
	};
}
