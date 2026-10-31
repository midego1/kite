/** How long a prepared question waits for the assistant panel before it is dropped. */
export const ASSISTANT_PROMPT_TTL_MS = 5 * 60 * 1000;

/** The session storage value of a prepared question: its text and when it was prepared. */
export function serializeAssistantPrompt(text: string, now: number): string {
	return JSON.stringify({ text, at: now });
}

/** The text of a stored entry, or null when it is malformed, from the future or older than the TTL. */
export function parseAssistantPrompt(stored: string, now: number): string | null {
	try {
		const entry = JSON.parse(stored) as { text?: unknown; at?: unknown } | null;
		if (typeof entry?.text !== "string" || typeof entry.at !== "number") return null;
		const age = now - entry.at;
		return age >= 0 && age < ASSISTANT_PROMPT_TTL_MS ? entry.text : null;
	} catch {
		return null;
	}
}
