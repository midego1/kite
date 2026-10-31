import { and, count, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { ExternalAccountRefusal } from "./errors";

/** The audit actions of connected accounts; metadata never carries a password, a user name or server text. */
export type ExternalAccountAuditAction =
	| "external_account.connected"
	| "external_account.updated"
	| "external_account.removed"
	| "external_account.connection_tested"
	| "external_account.permission_changed"
	| "external_account.install_switch_changed"
	| "external_account.credentials_erased"
	| "external_account.sync_failed"
	| "external_account.sync_recovered"
	| "external_identity.code_attempted"
	| "external_identity.code_requested"
	| "external_identity.verify_failed"
	| "external_identity.verified"
	| "external_identity.revoked";

export async function auditExternalAccount(
	env: CloudflareEnv,
	input: {
		actorUserId: string | null;
		action: ExternalAccountAuditAction;
		targetUserId?: string | null;
		mailboxId?: string | null;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	await createAuditLog(env, input);
}

/** Connection tests per user in `TEST_WINDOW_MS` (spec §11.2): the form cannot guess passwords or scan hosts. */
const CONNECTION_TESTS_PER_WINDOW = 10;
const TEST_WINDOW_MS = 10 * 60_000;

/**
 * Records one connection attempt and refuses it (429) when it is past the limit. The attempt is written first and the
 * count read afterwards, including it, so requests racing in parallel can never all see room: the n-th row written
 * always counts at least n. Every attempt counts, refused ones too, and it runs before the Kite password or anything
 * else is checked, so none of those checks can be tried more often than the limit allows.
 */
export async function recordConnectionTest(
	env: CloudflareEnv,
	userId: string,
	metadata: { host: string; port: number; preset: string; accountId?: string },
): Promise<void> {
	await auditExternalAccount(env, {
		actorUserId: userId,
		action: "external_account.connection_tested",
		metadata,
	});
	const [row] = await getDb(env)
		.select({ tests: count() })
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.actorUserId, userId),
				eq(auditLogs.action, "external_account.connection_tested"),
				gt(auditLogs.createdAt, new Date(Date.now() - TEST_WINDOW_MS)),
			),
		);
	if ((row?.tests ?? 0) > CONNECTION_TESTS_PER_WINDOW)
		throw new ExternalAccountRefusal(
			429,
			"Too many connection attempts. Wait ten minutes before trying again.",
			"RATE_LIMITED",
		);
}
