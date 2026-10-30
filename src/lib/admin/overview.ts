import { and, count, countDistinct, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, domains, mailboxes, users, webhookDeliveries, webhooks } from "@/db/schema";
import { canManageDomains, isPrimaryAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import type { AdminOverviewCounts } from "./overview-types";

/** Webhook failures and AI errors older than this are history, not something to act on. */
export const OVERVIEW_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Older failed AI requests are deleted as new ones arrive (`src/lib/agent/ai-errors.ts`), so a count can only reach this. */
const AI_ERRORS_KEPT = 200;

const sum = (condition: ReturnType<typeof sql>) =>
	sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;

/** A few `count` queries, never the rows themselves; the same scope as the pages the numbers open. */
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
		db
			.select({ total: count(), shared: sum(sql`${mailboxes.type} = 'shared'`) })
			.from(mailboxes)
			.then((rows) => rows[0]),
		canManageDomains(user)
			? db
					.select({ total: count(), active: sum(sql`${domains.status} = 'active'`) })
					.from(domains)
					.where(eq(domains.userId, user.id))
					.then((rows) => rows[0])
			: null,
		primary
			? db
					.select({ failingHooks: countDistinct(webhookDeliveries.webhookId), recentFailures: count() })
					.from(webhookDeliveries)
					.innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
					.where(
						and(
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
