import { authFetch } from "@/lib/auth/client";
import type { InstructionSet } from "@/lib/agent/instruction-types";

export type PersonalInstructionsState = { instructions: InstructionSet; ready: boolean; maxLength: number };

type AssistantSettingsBody = {
	instructions?: InstructionSet;
	instructionsReady?: boolean;
	instructionsMaxLength?: number;
	error?: unknown;
};

async function readState(response: Response, fallback: string): Promise<PersonalInstructionsState> {
	const data = (await response.json().catch(() => ({}))) as AssistantSettingsBody;
	if (!response.ok || !data.instructions) throw new Error(typeof data.error === "string" ? data.error : fallback);
	return {
		instructions: data.instructions,
		ready: data.instructionsReady !== false,
		maxLength: data.instructionsMaxLength ?? 2_000,
	};
}

export async function loadPersonalInstructions(): Promise<PersonalInstructionsState> {
	return readState(await authFetch("/api/settings/assistant"), "Failed to load your instructions");
}

export async function savePersonalInstructions(instructions: InstructionSet): Promise<PersonalInstructionsState> {
	const response = await authFetch("/api/settings/assistant", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ instructions }),
	});
	return readState(response, "Failed to save your instructions");
}
