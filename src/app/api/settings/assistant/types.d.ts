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
};
