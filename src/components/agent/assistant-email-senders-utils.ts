import { authFetch } from "@/lib/auth/client";

export type SenderAddress = { id: string; address: string; verified: boolean };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as T & { error?: unknown };
	if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : fallback);
	return data;
}

export async function loadSenderAddresses(): Promise<SenderAddress[]> {
	const data = await readJson<{ addresses: SenderAddress[] }>(
		await authFetch("/api/settings/assistant/email-senders"),
		"Failed to load addresses",
	);
	return data.addresses;
}

export async function addSenderAddress(address: string): Promise<void> {
	await readJson(
		await authFetch("/api/settings/assistant/email-senders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ address }),
		}),
		"Failed to add that address",
	);
}

export async function verifySenderAddress(id: string, code: string): Promise<void> {
	await readJson(
		await authFetch(`/api/settings/assistant/email-senders/${id}/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		}),
		"That code is wrong or has expired",
	);
}

export async function removeSenderAddress(id: string): Promise<void> {
	await readJson(
		await authFetch(`/api/settings/assistant/email-senders/${id}`, { method: "DELETE" }),
		"Failed to remove that address",
	);
}
