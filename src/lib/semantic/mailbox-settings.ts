import { and, eq, ne } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { mailboxAgentSettings } from "@/db/schema";
import { ensureMailboxAgentSettingsRow } from "@/lib/agent/auto-read/mailbox-settings";
import type { SessionUser } from "@/lib/auth/types";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { clearMailboxSemanticIndex, requeueMailboxSemanticIndex } from "./admin-actions";

/** "Include this mailbox in search by meaning" (Settings -> Assistant, `canManage`), migration 0099. */
const SEMANTIC_INDEX_AUDIT_ACTION = "search.mailbox_semantic_index";

/** On by default, including on a database that has not applied migration 0099 yet. */
export async function isMailboxSemanticIndexOn(db: AppDatabase, mailboxId: string): Promise<boolean> {
	try {
		const [row] = await db
			.select({ semanticIndex: mailboxAgentSettings.semanticIndex })
			.from(mailboxAgentSettings)
			.where(eq(mailboxAgentSettings.mailboxId, mailboxId))
			.limit(1);
		return row?.semanticIndex ?? true;
	} catch (error) {
		if (missingColumnFromError(error) === "semantic_index" || isNoSuchTableError(error)) return true;
		throw error;
	}
}

/**
 * Stores the switch for a mailbox the caller manages. Only a save that changes the stored value audits and runs
 * the cleanup (`docs/specs/semantic-search.md` section 5): turning it off marks the mailbox's rows `skipped` and
 * deletes their vectors; turning it on queues every eligible message again, `indexed` rows included, since their
 * vectors are gone and the backfill cursor may have long passed them.
 */
export async function setMailboxSemanticIndex(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	enabled: boolean,
): Promise<void> {
	const mailboxId = access.mailbox.id;
	const db = getDb(env);
	await ensureMailboxAgentSettingsRow(db, access);
	const changed = await db
		.update(mailboxAgentSettings)
		.set({ semanticIndex: enabled, updatedAt: new Date() })
		.where(and(eq(mailboxAgentSettings.mailboxId, mailboxId), ne(mailboxAgentSettings.semanticIndex, enabled)))
		.returning({ mailboxId: mailboxAgentSettings.mailboxId });
	if (changed.length === 0) return;
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId,
		action: SEMANTIC_INDEX_AUDIT_ACTION,
		metadata: { semanticIndex: enabled },
	});
	if (enabled) await requeueMailboxSemanticIndex(env, mailboxId);
	else await clearMailboxSemanticIndex(env, mailboxId);
}
