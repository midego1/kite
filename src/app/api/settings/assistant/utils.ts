import { TASK_INSTRUCTIONS_MAX_CHARS } from "@/lib/agent/instruction-utils";
import { AGENT_MAX_STEPS_MAX, AGENT_MAX_STEPS_MIN, clampAgentMaxSteps } from "@/lib/agent/step-limit-utils";
import type { UserAiSettingsState } from "@/lib/agent/user-ai-settings";
import { updateAssistantSettingsSchema } from "@/lib/validators";
import type { AssistantSettingsResponse, UpdateAssistantSettingsInput } from "./types";

export async function parseUpdateAssistantSettingsRequest(request: Request): Promise<UpdateAssistantSettingsInput> {
	return updateAssistantSettingsSchema.parse(await request.json());
}

export function assistantSettingsResponse(maxSteps: unknown, ai: UserAiSettingsState): AssistantSettingsResponse {
	return {
		maxSteps: clampAgentMaxSteps(maxSteps),
		minSteps: AGENT_MAX_STEPS_MIN,
		maxAllowedSteps: AGENT_MAX_STEPS_MAX,
		instructions: ai.instructions,
		instructionsReady: ai.ready,
		instructionsMaxLength: TASK_INSTRUCTIONS_MAX_CHARS,
	};
}
