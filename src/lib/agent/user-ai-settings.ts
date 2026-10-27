import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { userAiSettings } from "@/db/schema/agent-writing";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { InstructionSet, PersonalInstructions } from "./instruction-types";
import { EMPTY_INSTRUCTIONS } from "./instruction-utils";

export type UserAiSettingsState = {
	/** False until migration 0069 created `user_ai_settings`; everything then reads as empty and off. */
	ready: boolean;
	writingStyleEnabled: boolean;
	instructions: InstructionSet;
};

/** Saving before migration 0069 is applied; routes answer 409 `MIGRATION_PENDING`. */
export class UserAiSettingsPendingError extends Error {
	constructor() {
		super("Apply the pending database update first");
		this.name = "UserAiSettingsPendingError";
	}
}

/** The user's own AI settings: no row means empty instructions and the style profile off. */
export async function readUserAiSettings(db: AppDatabase, userId: string): Promise<UserAiSettingsState> {
	try {
		const [row] = await db.select().from(userAiSettings).where(eq(userAiSettings.userId, userId)).limit(1);
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
		};
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { ready: false, writingStyleEnabled: false, instructions: { ...EMPTY_INSTRUCTIONS } };
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
		await db
			.insert(userAiSettings)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: userAiSettings.userId, set: values });
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
