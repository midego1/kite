/** What went wrong when Kite signed in to an account, so the account gets the matching state (spec §6.5). */
export type ConnectionProblem = {
	kind: "auth" | "tls" | "refused" | "unreachable";
	/** The short reason shown to the owner: never the credentials, at most 300 characters. */
	message: string;
};

const MAX_MESSAGE = 300;

/** Server text is cut at 300 characters and stripped of control characters before it is stored or shown. */
function shortServerText(text: string): string {
	const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}

/**
 * Sorts a failed connection test. `refused` is Kite's own refusal (a private host, no TLS, no password sign-in), and
 * `secrets` are removed from the text in case a server echoed one back.
 */
export function classifyConnectionError(
	error: unknown,
	options: { refused: boolean; secrets?: readonly string[] },
): ConnectionProblem {
	let message = error instanceof Error && error.message ? error.message : "The connection failed";
	for (const secret of options.secrets ?? []) if (secret) message = message.split(secret).join("•••");
	const text = shortServerText(message);
	if (options.refused) return { kind: "refused", message: text };
	if (/sign-in failed|AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|invalid credentials|LOGIN failed/i.test(message))
		return { kind: "auth", message: `Sign-in failed. Check the user name and the (app) password. ${text}`.trim() };
	if (/certificate|TLS|SSL|handshake|self[- ]signed|CERT_|ERR_TLS/i.test(message))
		return { kind: "tls", message: text };
	return { kind: "unreachable", message: text };
}
