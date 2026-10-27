import { authFetch } from "@/lib/auth/client";

type WritingStyleProfile = {
	mailboxId: string;
	address: string;
	sampleCount: number;
	description: string | null;
	backfillPending: boolean;
};

export type WritingStyleState = { enabled: boolean; available: boolean; profiles: WritingStyleProfile[] };

async function json<T>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as T & { error?: unknown };
	if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : fallback);
	return data;
}

export async function loadWritingStyle(): Promise<WritingStyleState> {
	const settings = await json<{ writingStyle?: { enabled: boolean; available: boolean } }>(
		await authFetch("/api/settings/assistant"),
		"Could not load the writing style settings",
	);
	const style = settings.writingStyle ?? { enabled: false, available: false };
	if (!style.enabled) return { ...style, profiles: [] };
	const { profiles } = await json<{ profiles: WritingStyleProfile[] }>(
		await authFetch("/api/settings/assistant/writing-style"),
		"Could not load your writing style",
	);
	return { ...style, profiles };
}

export async function saveWritingStyleEnabled(enabled: boolean): Promise<void> {
	await json(
		await authFetch("/api/settings/assistant", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ writingStyle: { enabled } }),
		}),
		"Could not save the writing style setting",
	);
}

export async function resetWritingStyle(mailboxId: string): Promise<void> {
	await json(
		await authFetch(`/api/settings/assistant/writing-style?mailboxId=${encodeURIComponent(mailboxId)}`, {
			method: "DELETE",
		}),
		"Could not reset the writing style",
	);
}

export async function startWritingStyleBackfill(mailboxId: string): Promise<void> {
	await json(
		await authFetch("/api/settings/assistant/writing-style/backfill", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId }),
		}),
		"Could not learn from your sent mail",
	);
}
