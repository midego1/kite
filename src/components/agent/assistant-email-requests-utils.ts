import { authFetch } from "@/lib/auth/client";

export type EmailRequestSummary = {
	id: string;
	subject: string | null;
	status: "queued" | "running" | "answered" | "failed" | "refused";
	reason: string | null;
	createdAt: string;
	conversationPath: string | null;
};

export async function loadEmailRequests(): Promise<EmailRequestSummary[]> {
	const response = await authFetch("/api/agent/email-requests");
	const data = (await response.json().catch(() => ({}))) as { requests?: EmailRequestSummary[]; error?: unknown };
	if (!response.ok || !data.requests)
		throw new Error(typeof data.error === "string" ? data.error : "Failed to load requests");
	return data.requests;
}

const STATUS_TEXT: Record<EmailRequestSummary["status"], string> = {
	queued: "Waiting",
	running: "Running",
	answered: "Answered",
	failed: "Failed",
	refused: "Refused",
};

export function statusText(status: EmailRequestSummary["status"]): string {
	return STATUS_TEXT[status];
}
