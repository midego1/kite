/**
 * The column a "no such column" error names, if any. D1 and better-sqlite3 phrase it as
 * `no such column: agent_max_steps` (possibly table-qualified or quoted), sometimes only on the error's cause.
 */
export function missingColumnFromError(error: unknown): string | null {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth += 1) {
		if (current instanceof Error) messages.push(current.message);
		else if (typeof current === "string") messages.push(current);
		current = current instanceof Error ? current.cause : null;
	}
	for (const message of messages) {
		const match = /no such column: (?:"?\w+"?\.)?"?(\w+)"?/i.exec(message);
		if (match) return match[1];
	}
	return null;
}
