/**
 * What the database itself said in a message. Drizzle's wrapper (`Failed query: <sql>\nparams: <values>`) repeats the
 * statement and its bound values, which can hold any text a user typed, so a value reading "no such column: x" could
 * pass a real failure off as a pending migration: the wrapper says nothing of its own (its cause carries the
 * database's error), and any other message is read only up to a `params:` list.
 */
function databaseMessage(message: string): string {
	if (message.startsWith("Failed query:")) return "";
	const params = message.search(/(?:^|\n)\s*params:/);
	return params === -1 ? message : message.slice(0, params);
}

/**
 * The column a "no such column" error names, if any. D1 and better-sqlite3 phrase it as
 * `no such column: agent_max_steps` (possibly table-qualified or quoted), or for an insert as
 * `table users has no column named agent_max_steps`, sometimes only on the error's cause.
 */
export function missingColumnFromError(error: unknown): string | null {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth += 1) {
		if (current instanceof Error) messages.push(databaseMessage(current.message));
		else if (typeof current === "string") messages.push(databaseMessage(current));
		current = current instanceof Error ? current.cause : null;
	}
	// The database's own error is the innermost cause. The wrapper's message carries the query and its bound values,
	// which can hold text from a mail, so it is read last and never masks the real column.
	for (const message of messages.reverse()) {
		const match =
			/no such column: (?:"?\w+"?\.)?"?(\w+)"?/i.exec(message) ?? /has no column named "?(\w+)"?/i.exec(message);
		if (match) return match[1];
	}
	return null;
}
