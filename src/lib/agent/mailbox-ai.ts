import { and, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { mailboxAgentSettings } from "@/db/schema";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { MailboxAiOffError } from "./mailbox-ai-utils";

export { MailboxAiOffError } from "./mailbox-ai-utils";

/** Before migration 0091 the switch does not exist, so no mailbox can have it on: today's behaviour is kept. */
function beforeMigration(error: unknown): boolean {
	return missingColumnFromError(error) === "ai_disabled" || isNoSuchTableError(error);
}

/**
 * The gate. Of `mailboxIds`, the ones whose "No AI for this mailbox" switch is on. Every AI path asks it: the model
 * selection (`getAgentModel`) refuses a request that carries mail of such a mailbox, and the paths that only show
 * or schedule AI work (suggestions, one-line summaries, jobs, writing style) leave such a mailbox out.
 *
 * Fails closed: any read error other than the missing column of a pending migration propagates, so the caller's
 * AI request fails instead of running unchecked.
 */
export async function aiOffMailboxIds(
	source: CloudflareEnv | AppDatabase,
	mailboxIds: readonly string[],
): Promise<Set<string>> {
	const ids = [...new Set(mailboxIds.filter(Boolean))];
	if (ids.length === 0) return new Set();
	const db = "select" in source ? source : getDb(source);
	try {
		const rows = await db
			.select({ mailboxId: mailboxAgentSettings.mailboxId })
			.from(mailboxAgentSettings)
			// One JSON parameter: a list page or a user's mailboxes can pass D1's 100 bound parameters.
			.where(and(inJsonArray(mailboxAgentSettings.mailboxId, ids), eq(mailboxAgentSettings.aiDisabled, true)));
		return new Set(rows.map((row) => row.mailboxId));
	} catch (error) {
		if (beforeMigration(error)) return new Set();
		throw error;
	}
}

/** Whether AI is off for this mailbox. */
export async function mailboxAiOff(source: CloudflareEnv | AppDatabase, mailboxId: string): Promise<boolean> {
	return (await aiOffMailboxIds(source, [mailboxId])).size > 0;
}

/** Throws `MailboxAiOffError` when AI is off for this mailbox; the check before every model request. */
export async function assertMailboxAiAllowed(env: CloudflareEnv, mailboxId: string): Promise<void> {
	if (await mailboxAiOff(env, mailboxId)) throw new MailboxAiOffError();
}
