import { authFetch } from "@/lib/auth/client";

export type AssistantEmailSettingsState = {
	enabled: boolean;
	mailboxId: string | null;
	dailyLimit: number;
	ready: boolean;
	mailboxes: { id: string; label: string }[];
};

async function readEmailAssistant(response: Response, fallback: string): Promise<AssistantEmailSettingsState> {
	const data = (await response.json().catch(() => ({}))) as {
		emailAssistant?: AssistantEmailSettingsState;
		error?: unknown;
	};
	if (!response.ok || !data.emailAssistant) throw new Error(typeof data.error === "string" ? data.error : fallback);
	return data.emailAssistant;
}

export async function loadAssistantEmailSettings(): Promise<AssistantEmailSettingsState> {
	return readEmailAssistant(await authFetch("/api/settings/assistant"), "Failed to load assistant settings");
}

export async function saveAssistantEmailSettings(update: {
	enabled?: boolean;
	mailboxId?: string;
	dailyLimit?: number;
}): Promise<AssistantEmailSettingsState> {
	const response = await authFetch("/api/settings/assistant", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ emailAssistant: update }),
	});
	return readEmailAssistant(response, "Failed to save assistant settings");
}
