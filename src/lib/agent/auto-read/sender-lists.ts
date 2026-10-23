import { getDb } from "@/db";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { ensureMailboxAgentSettingsRow, readMailboxAgentSettings } from "./mailbox-settings";
import { updateSenderList } from "./muted-senders";
import { MAX_LISTED_SENDERS, SENDER_LIST_FIELDS, type SenderListEdit } from "./sender-lists-utils";

export type SenderListEditResult = { senders: string[]; changed: boolean } | { error: string };

/**
 * Adds or removes one address on the mailbox's trusted or muted senders with the same compare-and-set
 * as **Not phishing** and **Mute**, so a settings form loaded earlier can never drop another change.
 */
export async function editSenderList(
	env: CloudflareEnv,
	access: MailboxAccessLevel,
	edit: SenderListEdit,
): Promise<SenderListEditResult> {
	const db = getDb(env);
	const field = SENDER_LIST_FIELDS[edit.list];
	const before = (await readMailboxAgentSettings(db, access)).capabilities[field];
	if (edit.change === "add" && !before.includes(edit.sender)) {
		if (before.length >= MAX_LISTED_SENDERS)
			return { error: `A mailbox can have at most ${MAX_LISTED_SENDERS} ${edit.list} senders` };
		await ensureMailboxAgentSettingsRow(db, access);
	}
	const changed = await updateSenderList(env, access.mailbox.id, edit.sender, edit.change, field);
	return { senders: (await readMailboxAgentSettings(db, access)).capabilities[field], changed };
}
