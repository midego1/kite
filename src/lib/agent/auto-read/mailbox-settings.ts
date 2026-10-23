import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxAgentSettings } from "@/db/schema";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import type { MailboxAgentSettingsState } from "./settings-types";
import { resolveMailboxAgentSettings } from "./settings-utils";

function settingsContext(access: MailboxAccessLevel) {
	return { mailboxId: access.mailbox.id, ownerUserId: access.mailbox.userId, mailboxType: access.mailbox.type };
}

/** The mailbox's automatic reading settings, with defaults when it has never saved any. */
export async function readMailboxAgentSettings(
	db: AppDatabase,
	access: MailboxAccessLevel,
): Promise<MailboxAgentSettingsState> {
	const [row] = await db
		.select()
		.from(mailboxAgentSettings)
		.where(eq(mailboxAgentSettings.mailboxId, access.mailbox.id))
		.limit(1);
	return resolveMailboxAgentSettings(row, settingsContext(access));
}

/** Stores the defaults for a mailbox that has no settings row yet; an existing row is left alone. */
export async function ensureMailboxAgentSettingsRow(db: AppDatabase, access: MailboxAccessLevel): Promise<void> {
	const defaults = resolveMailboxAgentSettings(undefined, settingsContext(access));
	await db
		.insert(mailboxAgentSettings)
		.values({ ...defaults, enabled: true, capabilities: JSON.stringify(defaults.capabilities) })
		.onConflictDoNothing();
}
