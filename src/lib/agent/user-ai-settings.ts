import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { userAiSettings } from "@/db/schema/agent-writing";
import { insertRow, selectRow } from "@/lib/db/pending-columns";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { InstructionSet, PersonalInstructions } from "./instruction-types";
import { EMPTY_INSTRUCTIONS } from "./instruction-utils";

/**
 * Whether migration 0096's columns exist, for the settings page's own "ready" flag (`readUserAiSettings`'s
 * `selectRow` already reads safely around their absence, so it cannot tell the difference itself).
 */
export async function assistantEmailSettingsReady(env: CloudflareEnv): Promise<boolean> {
	return (await userAiSettingsColumns(env)).includes("assistant_email_enabled");
}

/** Whether migration 0069 created `user_ai_settings`, which every save in this file needs. */
export async function userAiSettingsReady(env: CloudflareEnv): Promise<boolean> {
	return (await userAiSettingsColumns(env)).length > 0;
}

/** The SQL names of `user_ai_settings`' columns; empty while the table does not exist. */
async function userAiSettingsColumns(env: CloudflareEnv): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('user_ai_settings')").all<{
		name: string;
	}>();
	return results.map((row) => row.name);
}

export type UserAiSettingsState = {
	/** False until migration 0069 created `user_ai_settings`; everything then reads as empty and off. */
	ready: boolean;
	writingStyleEnabled: boolean;
	instructions: InstructionSet;
	/** Assistant by email (migration 0096); empty and off while that migration is pending. */
	assistantEmail: { enabled: boolean; mailboxId: string | null; dailyLimit: number };
};

/** Saving before migration 0069 is applied; routes answer 409 `MIGRATION_PENDING`. */
export class UserAiSettingsPendingError extends Error {
	constructor() {
		super("Apply the pending database update first");
		this.name = "UserAiSettingsPendingError";
	}
}

const EMPTY_ASSISTANT_EMAIL = { enabled: false, mailboxId: null, dailyLimit: 20 };

/** The three columns migration 0096 adds, by their SQL names, the only ones an upsert here may miss. */
const ASSISTANT_EMAIL_COLUMN_NAMES = [
	userAiSettings.assistantEmailEnabled.name,
	userAiSettings.assistantEmailMailboxId.name,
	userAiSettings.assistantEmailDailyLimit.name,
];

/**
 * Upserts a row without ever naming the assistant-by-email columns in its own `values`: Drizzle's `insert().values()`
 * names every column the table declares, defaults and all, so a plain upsert fails with "no such column" before
 * migration 0096 even though `values` never touches those three. On exactly that failure, falls back to inserting
 * a row through `insertRow` (which already retries without a missing column) and then a plain `update().set()`,
 * which — unlike insert — only ever names the columns it is given, so it is pending-column-safe on its own.
 */
async function upsertUserAiSettings(
	db: AppDatabase,
	userId: string,
	values: Partial<typeof userAiSettings.$inferInsert>,
): Promise<void> {
	try {
		await db
			.insert(userAiSettings)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: userAiSettings.userId, set: values });
	} catch (error) {
		const column = missingColumnFromError(error);
		if (!column || !ASSISTANT_EMAIL_COLUMN_NAMES.includes(column)) throw error;
		await insertRow(db, userAiSettings, { userId, ...values }, { ignoreConflict: true });
		await db.update(userAiSettings).set(values).where(eq(userAiSettings.userId, userId));
	}
}

/**
 * The user's own AI settings: no row means empty instructions and the style profile off. Reads with `selectRow`,
 * so the assistant-by-email columns migration 0096 adds read as their defaults while it is pending, instead of
 * failing every caller of this function (chat, drafting, the composer).
 */
export async function readUserAiSettings(db: AppDatabase, userId: string): Promise<UserAiSettingsState> {
	try {
		const row = await selectRow(db, userAiSettings, eq(userAiSettings.userId, userId));
		return {
			ready: true,
			writingStyleEnabled: row?.writingStyleEnabled ?? false,
			instructions: row
				? {
						general: row.instructions,
						chat: row.chatInstructions,
						draft: row.draftInstructions,
						summary: row.summaryInstructions,
					}
				: { ...EMPTY_INSTRUCTIONS },
			assistantEmail: row
				? {
						enabled: row.assistantEmailEnabled,
						mailboxId: row.assistantEmailMailboxId,
						dailyLimit: row.assistantEmailDailyLimit,
					}
				: { ...EMPTY_ASSISTANT_EMAIL },
		};
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return {
			ready: false,
			writingStyleEnabled: false,
			instructions: { ...EMPTY_INSTRUCTIONS },
			assistantEmail: { ...EMPTY_ASSISTANT_EMAIL },
		};
	}
}

/** Saves the user's personal instructions; throws `UserAiSettingsPendingError` before migration 0069. */
export async function savePersonalInstructions(
	db: AppDatabase,
	userId: string,
	instructions: InstructionSet,
): Promise<void> {
	const values = {
		instructions: instructions.general,
		chatInstructions: instructions.chat,
		draftInstructions: instructions.draft,
		summaryInstructions: instructions.summary,
		updatedAt: new Date(),
	};
	try {
		await upsertUserAiSettings(db, userId, values);
	} catch (error) {
		if (isNoSuchTableError(error)) throw new UserAiSettingsPendingError();
		throw error;
	}
}

/** The personal instructions a prompt uses for this user, or null when they have none. */
export async function personalInstructionsFor(
	db: AppDatabase,
	user: { id: string; name: string },
): Promise<PersonalInstructions | null> {
	const { instructions } = await readUserAiSettings(db, user.id);
	if (!Object.values(instructions).some((value) => value.trim())) return null;
	return { ...instructions, name: user.name };
}

/** Turns the writing style opt-in on or off; throws `UserAiSettingsPendingError` before migration 0069. */
export async function saveWritingStyleEnabled(db: AppDatabase, userId: string, enabled: boolean): Promise<void> {
	const values = { writingStyleEnabled: enabled, updatedAt: new Date() };
	try {
		await upsertUserAiSettings(db, userId, values);
	} catch (error) {
		if (isNoSuchTableError(error)) throw new UserAiSettingsPendingError();
		throw error;
	}
}

/**
 * Saves the assistant-by-email opt-in, the mailbox a verified extra address's requests run in, and the daily
 * limit (spec §7, §13); throws `UserAiSettingsPendingError` before migration 0096. The caller validates
 * `mailboxId` belongs to the user before calling this (a plain write, like the two settings above).
 */
export async function saveAssistantEmailSettings(
	db: AppDatabase,
	userId: string,
	update: { enabled?: boolean; mailboxId?: string | null; dailyLimit?: number },
): Promise<void> {
	const values: Partial<typeof userAiSettings.$inferInsert> = { updatedAt: new Date() };
	if (update.enabled !== undefined) values.assistantEmailEnabled = update.enabled;
	if (update.mailboxId !== undefined) values.assistantEmailMailboxId = update.mailboxId;
	if (update.dailyLimit !== undefined) values.assistantEmailDailyLimit = update.dailyLimit;
	try {
		await db
			.insert(userAiSettings)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: userAiSettings.userId, set: values });
	} catch (error) {
		const column = missingColumnFromError(error);
		if (isNoSuchTableError(error) || (column && ASSISTANT_EMAIL_COLUMN_NAMES.includes(column)))
			throw new UserAiSettingsPendingError();
		throw error;
	}
}
