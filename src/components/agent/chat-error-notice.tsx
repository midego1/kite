"use client";

import { readAiErrorBody, type AiErrorBody } from "@/lib/agent/ai-error-utils";
import { AiErrorNotice } from "./ai-error-notice";
import type { AgentErrorResponse, AgentEvent } from "./types";

/** A failed chat turn: the server's code and details (none for a non-AI error) and the message to ask again. */
export type ChatFailure = { body: AiErrorBody | null; text: string };

/** The refused request's message; `onFailure` gets its details for the panel's notice. */
export async function chatRequestFailure(
	response: Response,
	text: string,
	onFailure: (failure: ChatFailure) => void,
): Promise<string> {
	const body = (await response.json().catch(() => ({}))) as AgentErrorResponse;
	onFailure({ body: readAiErrorBody(body), text });
	return body.error || "Assistant unavailable";
}

export function chatEventFailure(event: Extract<AgentEvent, { type: "error" }>, text: string): ChatFailure {
	return { body: readAiErrorBody({ error: event.message, ...event }), text };
}

/**
 * The assistant panel's error: an AI failure with its Details and Try again (which asks the same message again),
 * any other error (settings, drafts) as its message alone.
 */
export function ChatErrorNotice({
	error,
	failure,
	busy,
	onRetry,
}: {
	error: string;
	failure: ChatFailure | null;
	busy: boolean;
	onRetry: (text: string) => void;
}) {
	const current = failure?.body?.error === error ? failure : null;
	return (
		<AiErrorNotice
			className="mx-4 mt-3 rounded-xl border border-red-100 bg-red-50 p-3 text-sm"
			message={error}
			error={current?.body}
			onRetry={current && !busy ? () => onRetry(current.text) : undefined}
		/>
	);
}
