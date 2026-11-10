import { authFetch } from "@/lib/auth/client";
import type { McpConsentDetails, McpConsentLoad } from "./mcp-consent-types";

type Answer = Partial<McpConsentDetails> & {
	error?: unknown;
	redirectTo?: unknown;
	description?: unknown;
	redirectHost?: unknown;
};

async function answerOf(response: Response): Promise<Answer> {
	return response.json<Answer>().catch(() => ({}));
}

const message = (answer: Answer, fallback: string) => (typeof answer.error === "string" ? answer.error : fallback);

/** @public Exercised by the unit tests. The authorization request's parameters as one object, as the decision route takes them. */
export function queryParams(query: string): Record<string, string> {
	return Object.fromEntries(new URLSearchParams(query));
}

export async function loadConsent(query: string): Promise<McpConsentLoad> {
	const response = await authFetch(`/api/oauth/authorize?${query}`);
	const answer = await answerOf(response);
	if (typeof answer.redirectTo === "string")
		return {
			kind: "redirect",
			url: answer.redirectTo,
			message: typeof answer.description === "string" ? answer.description : "The app sent a request Kite cannot use",
			host: typeof answer.redirectHost === "string" ? answer.redirectHost : "the app",
		};
	if (!response.ok || !answer.client) return { kind: "error", message: message(answer, "This request cannot be used") };
	return { kind: "details", details: answer as McpConsentDetails };
}

/** Sends the user's answer and returns the client URL to go back to. */
export async function decideConsent(input: {
	query: string;
	decision: "allow" | "deny";
	scopes: string[];
	mailboxIds: string[];
}): Promise<string> {
	const response = await authFetch("/api/oauth/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			params: queryParams(input.query),
			decision: input.decision,
			scopes: input.scopes,
			mailboxIds: input.mailboxIds,
		}),
	});
	const answer = await answerOf(response);
	if (!response.ok || typeof answer.redirectTo !== "string")
		throw new Error(message(answer, "Could not finish connecting the app"));
	return answer.redirectTo;
}

/** `list` with `value` added (`on`) or removed. */
export function toggled(list: readonly string[], value: string, on: boolean): string[] {
	return on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}
