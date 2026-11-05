import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxAgentSettings } from "@/db/schema";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { aiSummaries } from "@/db/schema/agent-summaries";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { skipPendingMailboxJobs } from "./auto-read/install-settings";
import { ensureMailboxAgentSettingsRow } from "./auto-read/mailbox-settings";
import { notifySuggestionsQuietly } from "./auto-read/suggestion-events";
import { MAILBOX_AI_OFF_REASON } from "./mailbox-ai-utils";

/** The audit action of turning "No AI for this mailbox" on or off. */
const MAILBOX_AI_AUDIT_ACTION = "agent.mailbox_ai";

/** Databases known to have applied 0091; migrations only add, so a hit is final for the isolate's life. */
const appliedDatabases = new WeakSet<object>();

/**
 * Whether the switch can be stored: false before migration 0091, when a save answers 409 `MIGRATION_PENDING`. Reads
 * only the column list, never the column itself.
 */
export async function mailboxAiSwitchAvailable(env: CloudflareEnv): Promise<boolean> {
	if (appliedDatabases.has(env.DB)) return true;
	const { results } = await env.DB.prepare("PRAGMA table_info(mailbox_agent_settings)").all<{ name: string }>();
	if (!results.some((column) => column.name === "ai_disabled")) return false;
	appliedDatabases.add(env.DB);
	return true;
}

/**
 * Turning AI off: stops queued jobs, expires open suggestions (the reader and For you stop showing them; the action
 * log keeps its references) and deletes the stored summaries and one-line summaries, which are derived and never
 * backed up. No model is called.
 */
async function clearMailboxAi(env: CloudflareEnv, mailboxId: string): Promise<void> {
	for (const kind of ["triage", "draft", "line_summary"] as const)
		await skipPendingMailboxJobs(env, mailboxId, kind, MAILBOX_AI_OFF_REASON);
	const db = getDb(env);
	const expired = await db
		.update(agentSuggestions)
		.set({ status: "expired", decidedAt: new Date() })
		.where(and(eq(agentSuggestions.mailboxId, mailboxId), eq(agentSuggestions.status, "open")))
		.returning({ id: agentSuggestions.id })
		.catch((error: unknown) => {
			if (isNoSuchTableError(error)) return [];
			throw error;
		});
	await notifySuggestionsQuietly(
		env,
		expired.map((row) => row.id),
	);
	await db
		.delete(aiSummaries)
		.where(eq(aiSummaries.mailboxId, mailboxId))
		.catch((error: unknown) => {
			if (!isNoSuchTableError(error)) throw error;
		});
}

/**
 * Stores the switch for a mailbox the caller manages (the route checks `canManage`). Only a save that changes the
 * stored value writes the audit row (decided by the update itself, so two saves at once audit once), and it is
 * written before the cleanup. The cleanup runs both ways: turning AI off removes what AI made, and turning it back on
 * removes anything a request that raced the switch wrote while it was off. Answers `migration_pending` before 0091
 * and changes nothing then.
 */
export async function setMailboxAiDisabled(
	env: CloudflareEnv,
	user: SessionUser,
	access: MailboxAccessLevel,
	disabled: boolean,
): Promise<"saved" | "migration_pending"> {
	if (!(await mailboxAiSwitchAvailable(env))) return "migration_pending";
	const mailboxId = access.mailbox.id;
	const db = getDb(env);
	await ensureMailboxAgentSettingsRow(db, access);
	const changed = await db
		.update(mailboxAgentSettings)
		.set({ aiDisabled: disabled, updatedAt: new Date() })
		.where(and(eq(mailboxAgentSettings.mailboxId, mailboxId), ne(mailboxAgentSettings.aiDisabled, disabled)))
		.returning({ mailboxId: mailboxAgentSettings.mailboxId });
	if (changed.length > 0)
		await createAuditLog(env, {
			actorUserId: user.id,
			mailboxId,
			action: MAILBOX_AI_AUDIT_ACTION,
			metadata: { aiDisabled: disabled },
		});
	if (disabled || changed.length > 0) await clearMailboxAi(env, mailboxId);
	return "saved";
}
