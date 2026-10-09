import { authFetch } from "@/lib/auth/client";
import type { SendingSettings } from "./use-sending-settings-types";

type SendingSettingsResponse = Partial<SendingSettings> & { error?: unknown };

async function readSettings(response: Response, fallback: string): Promise<SendingSettings> {
	const data = (await response.json()) as SendingSettingsResponse;
	if (!response.ok || typeof data.previewEnabled !== "boolean" || typeof data.undoSeconds !== "number") {
		throw new Error(typeof data.error === "string" ? data.error : fallback);
	}
	return { previewEnabled: data.previewEnabled, undoSeconds: data.undoSeconds };
}

export async function loadSendingSettings(): Promise<SendingSettings> {
	const response = await authFetch("/api/settings/sending");
	return readSettings(response, "Failed to load sending settings");
}

export async function updateSendingSettings(patch: Partial<SendingSettings>): Promise<SendingSettings> {
	const response = await authFetch("/api/settings/sending", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	return readSettings(response, "Failed to update sending settings");
}
