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

/** Databases known to have applied 0099; migrations only add, so a hit is final for the isolate's life. */
const appliedDatabases = new WeakSet<object>();

/** Whether `mailbox_agent_settings.semantic_index` exists: false before migration 0099, when a save must not try it. */
async function semanticIndexColumnReady(env: CloudflareEnv): Promise<boolean> {
	if (appliedDatabases.has(env.DB)) return true;
	const { results } = await env.DB.prepare("PRAGMA table_info(mailbox_agent_settings)").all<{ name: string }>();
	const ready = results.some((column) => column.name === "semantic_index");
	if (ready) appliedDatabases.add(env.DB);
	return ready;
}

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
 * vectors are gone and the backfill cursor may have long passed them. Answers `migration_pending` before 0099,
 * like `setMailboxAiDisabled` (S4 of review round 2): without the check, the update below would throw "no such
 * column" instead.
 */
export async function setMailboxSemanticIndex(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	enabled: boolean,
): Promise<"saved" | "migration_pending"> {
	if (!(await semanticIndexColumnReady(env))) return "migration_pending";
	const mailboxId = access.mailbox.id;
	const db = getDb(env);
	await ensureMailboxAgentSettingsRow(db, access);
	const changed = await db
		.update(mailboxAgentSettings)
		.set({ semanticIndex: enabled, updatedAt: new Date() })
		.where(and(eq(mailboxAgentSettings.mailboxId, mailboxId), ne(mailboxAgentSettings.semanticIndex, enabled)))
		.returning({ mailboxId: mailboxAgentSettings.mailboxId });
	const audit = () =>
		createAuditLog(env, {
			actorUserId: user.id,
			mailboxId,
			action: SEMANTIC_INDEX_AUDIT_ACTION,
			metadata: { semanticIndex: enabled },
		});
	// Off always clears (a no-op when nothing is indexed), so a retry after a failed cleanup still removes the
	// vectors, as `setMailboxAiDisabled` does. On requeues only after a change, since it re-embeds the whole
	// mailbox; if that fails the switch is put back (only while it still holds the value this save wrote, so a
	// concurrent save is never overwritten) and no "on" is audited, so the retry sees a change and runs it again.
	if (!enabled) {
		if (changed.length > 0) await audit();
		await clearMailboxSemanticIndex(env, mailboxId);
	} else if (changed.length > 0) {
		try {
			await requeueMailboxSemanticIndex(env, mailboxId);
		} catch (error) {
			await db
				.update(mailboxAgentSettings)
				.set({ semanticIndex: false, updatedAt: new Date() })
				.where(and(eq(mailboxAgentSettings.mailboxId, mailboxId), eq(mailboxAgentSettings.semanticIndex, true)));
			throw error;
		}
		await audit();
	}
	return "saved";
}
