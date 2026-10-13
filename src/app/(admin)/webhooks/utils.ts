import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import type { CreateWebhookInput, UpdateWebhookInput, Webhook, WebhookDelivery, WebhookEventOption } from "./types";

export const DELIVERY_STATUS_LABELS = {
	pending: "Pending",
	delivered: "Delivered",
	failed: "Failed",
	retrying: "Retrying",
	exhausted: "Gave up",
} as const;

async function readJson<T>(res: Response): Promise<T> {
	const json = (await res.json()) as T & { error?: unknown };
	if (!res.ok) {
		throw new Error(typeof json.error === "string" ? json.error : "Request failed");
	}
	return json;
}

export async function fetchWebhooks(): Promise<{ webhooks: Webhook[]; eventCatalog: WebhookEventOption[] }> {
	const json = await readJson<{ webhooks: Webhook[]; eventCatalog?: WebhookEventOption[] }>(
		await authFetch("/api/webhooks"),
	);
	return { webhooks: json.webhooks ?? [], eventCatalog: json.eventCatalog ?? [] };
}

export async function fetchDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
	const json = await readJson<{ deliveries: WebhookDelivery[] }>(
		await authFetch(`/api/webhooks/${webhookId}/deliveries?limit=50`),
	);
	return json.deliveries ?? [];
}

export async function createWebhook(input: CreateWebhookInput) {
	return readJson<{ id: string; secret: string }>(
		await authFetch("/api/webhooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

export async function updateWebhook(id: string, input: UpdateWebhookInput) {
	return readJson<{ ok: boolean; secret?: string }>(
		await authFetch(`/api/webhooks/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

export async function deleteWebhook(id: string) {
	return readJson(await authFetch(`/api/webhooks/${id}`, { method: "DELETE" }));
}

export async function testWebhook(id: string) {
	return readJson<{ deliveryId: string; status: string }>(
		await authFetch(`/api/webhooks/${id}/test`, { method: "POST" }),
	);
}

export async function retryDelivery(webhookId: string, deliveryId: string) {
	return readJson<{ status: string }>(
		await authFetch(`/api/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, {
			method: "POST",
		}),
	);
}

/** Drizzle timestamps arrive as epoch seconds when they bypass the column mapper. */
export function formatTimestamp(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return "—";
	const numeric = typeof value === "number" ? value : Date.parse(String(value));
	if (!Number.isFinite(numeric)) return "—";
	const ms = numeric < 1e12 ? numeric * 1000 : numeric;
	return formatUserDate(new Date(ms), { dateStyle: "medium", timeStyle: "short" });
}

export function formatDuration(ms: number | null): string {
	if (ms === null || ms === undefined) return "—";
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function isRetryable(delivery: WebhookDelivery): boolean {
	return delivery.status !== "delivered";
}
