const AGENT_TOOL_HISTORY_LIMIT = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function fits(value: unknown, limit: number) {
	const json = JSON.stringify(value) ?? "null";
	return json.length <= limit ? json : null;
}

/**
 * Serializes a tool result for the chat history so it always stays valid JSON.
 * Proposals awaiting approval are kept whole because approving one re-reads it;
 * other large results drop list items and long text instead of being cut mid-string.
 */
export function serializeAgentToolOutput(output: unknown, limit = AGENT_TOOL_HISTORY_LIMIT): string {
	const json = JSON.stringify(output) ?? "null";
	if (json.length <= limit) return json;
	if (!isRecord(output)) return JSON.stringify({ truncated: true, preview: json.slice(0, limit / 2) });
	if (output.status === "pending_approval") return json;

	const compact: Record<string, unknown> = { ...output, truncated: true };
	if (typeof compact.text === "string") compact.text = compact.text.slice(0, limit / 2);
	const fitted = fits(compact, limit);
	if (fitted) return fitted;

	const emails = Array.isArray(output.emails) ? output.emails : null;
	if (emails) {
		let keep = emails.length;
		while (keep > 0) {
			keep = Math.floor(keep / 2);
			const trimmed = fits({ ...compact, emails: emails.slice(0, keep), omittedEmails: emails.length - keep }, limit);
			if (trimmed) return trimmed;
		}
	}
	return JSON.stringify({ truncated: true, preview: json.slice(0, limit / 2) });
}
