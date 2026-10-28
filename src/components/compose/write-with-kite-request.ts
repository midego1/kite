import { readAiErrorBody, type AiErrorBody } from "@/lib/agent/ai-error-utils";
import { authFetch } from "@/lib/auth/client";
import { parseComposeEvents } from "./write-with-kite-utils";

export type ComposeAnswer =
	{ ok: true; text: string; warnings: string[] } | { ok: false; message: string; error?: AiErrorBody | null };

/**
 * One composer request: posts it, passes each streamed delta to `onPreview` and resolves with the checked final text
 * (never the raw deltas) or the refusal the server gave.
 */
export async function streamCompose(
	body: Record<string, unknown>,
	signal: AbortSignal,
	onPreview: (preview: string) => void,
): Promise<ComposeAnswer> {
	const response = await authFetch("/api/agent/compose", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal,
		body: JSON.stringify(body),
	});
	if (!response.ok || !response.body) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		return { ok: false, message: data.error || "Kite could not write this. Try again.", error: readAiErrorBody(data) };
	}
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	let preview = "";
	let answer: ComposeAnswer = { ok: false, message: "Kite stopped before it finished. Try again." };
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return answer;
		const parsed = parseComposeEvents(buffer + value);
		buffer = parsed.rest;
		for (const event of parsed.events) {
			if (event.type === "text") onPreview((preview += event.text));
			else if (event.type === "done") answer = { ok: true, text: event.text, warnings: event.warnings };
			else answer = { ok: false, message: event.error, error: readAiErrorBody(event) };
		}
	}
}
