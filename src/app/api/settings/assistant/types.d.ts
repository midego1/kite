import type { updateAssistantSettingsSchema } from "@/lib/validators";
import type { InstructionSet } from "@/lib/agent/instruction-types";
import type { z } from "zod";

export type UpdateAssistantSettingsInput = z.infer<typeof updateAssistantSettingsSchema>;

export type AssistantSettingsResponse = {
	maxSteps: number;
	minSteps: number;
	maxAllowedSteps: number;
	/** The user's own instructions; empty strings until they write any. */
	instructions: InstructionSet;
	/** False until migration 0069 is applied; the personal instructions cannot be saved before. */
	instructionsReady: boolean;
	instructionsMaxLength: number;
	/** The writing style opt-in; `available` is false until migration 0070 is applied. */
	writingStyle: { enabled: boolean; available: boolean };
	/** Assistant by email (migration 0096); `ready` is false until that migration is applied. */
	emailAssistant: {
		enabled: boolean;
		mailboxId: string | null;
		dailyLimit: number;
		ready: boolean;
		/** The user's own personal mailboxes, for the mailbox picker a verified extra address's requests run in. */
		mailboxes: { id: string; label: string }[];
	};
};
