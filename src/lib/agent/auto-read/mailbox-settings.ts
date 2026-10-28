import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxAgentSettings } from "@/db/schema";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { insertRow, selectRow } from "@/lib/db/pending-columns";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import type { MailboxAgentSettingsState } from "./settings-types";
import { LIST_SUMMARY_DEFAULTS, resolveMailboxAgentSettings, TASK_INSTRUCTION_KEYS } from "./settings-utils";

type MailboxAgentSettingsRow = typeof mailboxAgentSettings.$inferInsert;

const LIST_SUMMARY_KEYS = Object.keys(LIST_SUMMARY_DEFAULTS) as (keyof typeof LIST_SUMMARY_DEFAULTS)[];
// Columns a deploy may run ahead of: 0069's task instructions and 0072's one-line summary settings.
const PENDING_KEYS: readonly string[] = [...TASK_INSTRUCTION_KEYS, ...LIST_SUMMARY_KEYS];
const PENDING_COLUMNS: readonly string[] = [...TASK_INSTRUCTION_KEYS, ...LIST_SUMMARY_KEYS].map(
	(key) => mailboxAgentSettings[key].name,
);

/** Whether an update stores something in a pending column that would be lost without its migration. */
function setsPendingValue(values: MailboxAgentSettingsRow): boolean {
	return (
		TASK_INSTRUCTION_KEYS.some((key) => values[key]) ||
		LIST_SUMMARY_KEYS.some((key) => values[key] !== undefined && values[key] !== LIST_SUMMARY_DEFAULTS[key])
	);
}

function settingsContext(access: MailboxAccessLevel) {
	return { mailboxId: access.mailbox.id, ownerUserId: access.mailbox.userId, mailboxType: access.mailbox.type };
}

/**
 * The mailbox's stored settings row. Whole-row reads go through `selectRow`, so the task instruction columns
 * read as empty while migration 0069 is pending instead of failing the chat, the drafts and automatic reading.
 */
export function readMailboxAgentSettingsRow(db: AppDatabase, mailboxId: string) {
	return selectRow(db, mailboxAgentSettings, eq(mailboxAgentSettings.mailboxId, mailboxId));
}

/** The mailbox's automatic reading settings, with defaults when it has never saved any. */
export async function readMailboxAgentSettings(
	db: AppDatabase,
	access: MailboxAccessLevel,
): Promise<MailboxAgentSettingsState> {
	const row = await readMailboxAgentSettingsRow(db, access.mailbox.id);
	return resolveMailboxAgentSettings(row, settingsContext(access));
}

/** Stores the defaults for a mailbox that has no settings row yet; an existing row is left alone. */
export async function ensureMailboxAgentSettingsRow(db: AppDatabase, access: MailboxAccessLevel): Promise<void> {
	const defaults = resolveMailboxAgentSettings(undefined, settingsContext(access));
	await insertRow(
		db,
		mailboxAgentSettings,
		{ ...defaults, enabled: true, capabilities: JSON.stringify(defaults.capabilities) },
		{ ignoreConflict: true },
	);
}

/**
 * Inserts or replaces the mailbox's settings. Before migration 0069 the row is saved without the task
 * instruction columns, unless the update would store text there: then nothing is saved and the answer is
 * `migration_pending`, so no instruction is dropped without the user knowing.
 */
export async function saveMailboxAgentSettings(
	db: AppDatabase,
	values: MailboxAgentSettingsRow,
): Promise<"saved" | "migration_pending"> {
	const { mailboxId, ...updates } = values;
	try {
		await db
			.insert(mailboxAgentSettings)
			.values(values)
			.onConflictDoUpdate({ target: mailboxAgentSettings.mailboxId, set: { ...updates, updatedAt: new Date() } });
		return "saved";
	} catch (error) {
		const column = missingColumnFromError(error);
		if (!column || !PENDING_COLUMNS.includes(column)) throw error;
		if (setsPendingValue(values)) return "migration_pending";
		const legacy = Object.fromEntries(Object.entries(updates).filter(([key]) => !PENDING_KEYS.includes(key))) as Omit<
			MailboxAgentSettingsRow,
			"mailboxId"
		>;
		await insertRow(db, mailboxAgentSettings, values, { ignoreConflict: true });
		await db
			.update(mailboxAgentSettings)
			.set({ ...legacy, updatedAt: new Date() })
			.where(eq(mailboxAgentSettings.mailboxId, mailboxId));
		return "saved";
	}
}
