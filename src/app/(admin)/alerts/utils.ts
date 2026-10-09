import { authFetch } from "@/lib/auth/client";
import type { AlertWebhookKindSetting } from "@/lib/alerts/alerts-types";
import type { AlertWebhookStatus, AlertWebhookTestResult } from "./types";

const ENDPOINT = "/api/admin/alerts/webhook";

export const KIND_OPTIONS: { value: AlertWebhookKindSetting; label: string }[] = [
	{ value: "auto", label: "Auto-detect" },
	{ value: "slack", label: "Slack" },
	{ value: "discord", label: "Discord" },
	{ value: "ntfy", label: "ntfy" },
	{ value: "json", label: "Generic JSON" },
];

export function kindLabel(kind: AlertWebhookKindSetting): string {
	return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

const URL_ERROR_TEXT: Record<string, string> = {
	invalid_url: "Enter a valid webhook URL starting with https://.",
	credentials_not_allowed: "Remove the user name or password from the URL.",
	https_required: "Use an https:// URL.",
	blocked_host: "This address is private or local and cannot receive alerts.",
};

const TEST_FAILURE_TEXT: Record<string, string> = {
	timeout: "the webhook did not answer in time",
	network: "the webhook could not be reached",
	http_status: "the webhook answered with an error",
	blocked_url: "the saved address is no longer allowed",
	unreadable: "the saved URL could not be decrypted; save it again",
};

/** Builds the inline message for a failed test send. The remote response body is never shown. */
export function describeTestFailure(result: { reason?: string; status?: number; error?: string }): string {
	const reason = result.reason
		? (TEST_FAILURE_TEXT[result.reason] ?? result.reason)
		: (result.error ?? "unknown error");
	const status = result.status === undefined ? "" : ` (HTTP ${result.status})`;
	return `Test failed: ${reason}${status}.`;
}

async function readStatus(response: Response, fallback: string): Promise<AlertWebhookStatus> {
	const data = (await response.json().catch(() => ({}))) as Partial<AlertWebhookStatus> & {
		error?: string;
		code?: string;
	};
	if (!response.ok) {
		throw new Error((data.code && URL_ERROR_TEXT[data.code]) ?? data.error ?? fallback);
	}
	return data as AlertWebhookStatus;
}

export async function loadAlertWebhook(): Promise<AlertWebhookStatus> {
	return readStatus(await authFetch(ENDPOINT, { cache: "no-store" }), "Could not load the alert webhook");
}

export async function saveAlertWebhook(input: {
	url?: string;
	kind: AlertWebhookKindSetting;
}): Promise<AlertWebhookStatus> {
	const response = await authFetch(ENDPOINT, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return readStatus(response, "Could not save the alert webhook");
}

export async function removeAlertWebhook(): Promise<AlertWebhookStatus> {
	return readStatus(await authFetch(ENDPOINT, { method: "DELETE" }), "Could not remove the alert webhook");
}

export async function sendTestAlert(): Promise<AlertWebhookTestResult> {
	const response = await authFetch(`${ENDPOINT}/test`, { method: "POST" });
	const data = (await response.json().catch(() => ({}))) as AlertWebhookTestResult & { error?: string };
	if (response.ok) return { ok: true, status: "status" in data ? data.status : undefined };
	return { ...data, ok: false } as AlertWebhookTestResult;
}
