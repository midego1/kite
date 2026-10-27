import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes, messages } from "@/db/schema";
import { readMailboxAgentSettingsRow } from "./mailbox-settings";
import { loadDraftThread } from "../jobs/draft-generation";
import { selectAutoReadModel } from "./auto-read-model";
import { collectThreadReferences, guardDraft } from "./draft-guard-utils";
import { getAutoReadInstallSettings } from "./install-settings";
import { namesATime, PROPOSAL_INSTRUCTIONS } from "./invite-actions-utils";
import { generateDraft } from "./reply-suggestion";
import { resolveMailboxAgentSettings } from "./settings-utils";

/**
 * The opening lines of a "propose a new time" reply, written by the shared draft generation. The model
 * never picks times: code appends them, and an intro that names one is dropped. Null means "use the
 * fixed wording", which also covers no model, an unconfigured provider and a reached spend cap.
 */
export async function generateProposalIntro(
	env: CloudflareEnv,
	input: { suggestionId: string; mailboxId: string; messageId: string },
): Promise<string | null> {
	try {
		const db = getDb(env);
		const install = await getAutoReadInstallSettings(env);
		if (!install.agentEnabled || !install.autoReadEnabled) return null;
		const [source] = await db.select().from(messages).where(eq(messages.id, input.messageId)).limit(1);
		const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).limit(1);
		const row = await readMailboxAgentSettingsRow(db, input.mailboxId);
		if (!source || !mailbox || !row) return null;
		const settings = resolveMailboxAgentSettings(row, {
			mailboxId: mailbox.id,
			ownerUserId: mailbox.userId,
			mailboxType: mailbox.type,
		});
		const selection = await selectAutoReadModel(env, settings.modelId);
		const thread = await loadDraftThread(db, mailbox.id, source);
		const instructed = { ...settings, instructions: `${settings.instructions}\n\n${PROPOSAL_INSTRUCTIONS}`.trim() };
		const text = await generateDraft(
			{
				env,
				job: { id: input.suggestionId, mailboxId: mailbox.id, reviewerUserId: mailbox.userId },
				settings: instructed,
				installCapMicros: install.dailySpendCapMicros,
				tokenCap: install.autoReadTokenCap,
			},
			selection,
			thread,
		);
		const references = collectThreadReferences(
			thread.flatMap((message) => [
				message.textBody,
				message.htmlBody,
				message.fromAddr,
				message.toAddr,
				message.ccAddr,
			]),
		);
		const guarded = guardDraft(text, references);
		return guarded.ok && !namesATime(guarded.text) ? guarded.text : null;
	} catch {
		return null;
	}
}
