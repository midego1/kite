/**
 * Writes whose success can change a field of `/api/auth/me`: profile and
 * preference settings, avatars, account edits, and mailbox or domain setup
 * (which drive `hasMailboxes` and `isSetup`).
 */
const ACCOUNT_WRITE_PATH = /^\/api\/(settings|profile|accounts|mailboxes|domains|setup)(\/|$)/;

export function changesCurrentAccount(input: RequestInfo | URL, method: string | undefined): boolean {
	const verb = (
		method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
	).toUpperCase();
	if (verb === "GET" || verb === "HEAD") return false;
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	let pathname: string;
	try {
		pathname = new URL(raw, "http://localhost").pathname;
	} catch {
		return false;
	}
	return ACCOUNT_WRITE_PATH.test(pathname);
}
