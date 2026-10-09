import { authFetch } from "@/lib/auth/client";

async function readMaxSteps(response: Response, fallback: string): Promise<number> {
	const data = (await response.json().catch(() => ({}))) as { maxSteps?: unknown; error?: unknown };
	if (!response.ok || typeof data.maxSteps !== "number")
		throw new Error(typeof data.error === "string" ? data.error : fallback);
	return data.maxSteps;
}

export async function loadAgentMaxSteps(): Promise<number> {
	return readMaxSteps(await authFetch("/api/settings/assistant"), "Failed to load assistant settings");
}

export async function saveAgentMaxSteps(maxSteps: number): Promise<number> {
	const response = await authFetch("/api/settings/assistant", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ maxSteps }),
	});
	return readMaxSteps(response, "Failed to save assistant settings");
}
