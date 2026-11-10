import type { ImapImportInput } from "@/lib/import/imap-types";
import { parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import type { ImapImportRequest } from "./types";

/**
 * The sign-in of an import request: the user name with the password, or with a connected OAuth account's access token
 * (only `resolveImportSource` sets one, and it replaces the password).
 */
export function parseImapSignIn(
	input: Pick<ImapImportRequest, "username" | "password" | "accessToken">,
): Pick<ImapImportInput, "username" | "password" | "accessToken"> {
	const username = input.username?.trim() ?? "";
	const password = input.password ?? "";
	const accessToken = typeof input.accessToken === "string" && input.accessToken ? input.accessToken : undefined;
	if (!username || (!password && !accessToken)) throw new Error("IMAP username and password are required");
	return { username, password, ...(accessToken ? { accessToken } : {}) };
}

export function parseImapImportRequest(input: ImapImportRequest): ImapImportInput & {
	mailboxId: string;
	destination: ImportDestination;
} {
	const host = input.host?.trim() ?? "";
	const port = Number(input.port ?? 993);
	const folder = input.folder?.trim() || "INBOX";
	const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 100);
	const offset = Math.max(Math.floor(Number(input.offset ?? 0)) || 0, 0);
	const destination = parseImportDestination(input.destination);

	if (!input.mailboxId) throw new Error("Mailbox is required");
	if (!host) throw new Error("IMAP host is required");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IMAP port is invalid");

	return {
		mailboxId: input.mailboxId,
		host,
		port,
		secure: input.secure ?? port === 993,
		...parseImapSignIn(input),
		folder,
		limit,
		offset,
		destination,
	};
}
