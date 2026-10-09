import { AGENT_MAX_STEPS_MAX, AGENT_MAX_STEPS_MIN, clampAgentMaxSteps } from "@/lib/agent/step-limit-utils";
import { updateAssistantSettingsSchema } from "@/lib/validators";
import type { AssistantSettingsResponse, UpdateAssistantSettingsInput } from "./types";

export async function parseUpdateAssistantSettingsRequest(request: Request): Promise<UpdateAssistantSettingsInput> {
	return updateAssistantSettingsSchema.parse(await request.json());
}

export function assistantSettingsResponse(maxSteps: unknown): AssistantSettingsResponse {
	return {
		maxSteps: clampAgentMaxSteps(maxSteps),
		minSteps: AGENT_MAX_STEPS_MIN,
		maxAllowedSteps: AGENT_MAX_STEPS_MAX,
	};
}
