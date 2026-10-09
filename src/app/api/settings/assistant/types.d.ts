import type { updateAssistantSettingsSchema } from "@/lib/validators";
import type { z } from "zod";

export type UpdateAssistantSettingsInput = z.infer<typeof updateAssistantSettingsSchema>;

export type AssistantSettingsResponse = {
	maxSteps: number;
	minSteps: number;
	maxAllowedSteps: number;
};
