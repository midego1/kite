import { openImapSession } from "@/lib/imap/session";
import { IMAP_PORTS } from "@/lib/imap/protocol-utils";
import { mailHostPolicy, mailServerHostProblem } from "@/lib/net/host-guard-utils";
import type { ImportMessageInput } from "./types";
import type { ImapImportInput } from "./imap-types";
import { chunk, imapSecurity, importMessageFromImap, selectImapUidBatch } from "./imap-utils";

/** Messages fetched per UID FETCH command. */
const FETCH_CHUNK_SIZE = 25;

type ImapImportEnv = Parameters<typeof openImapSession>[0];
type ImapAccount = Pick<ImapImportInput, "host" | "port" | "secure" | "username" | "password">;

/** Signs in to the source account of an import (`secure` off means STARTTLS, never plain text). */
export function openImportSession(env: ImapImportEnv, input: ImapAccount) {
	return openImapSession(env, {
		host: input.host,
		port: input.port,
		security: imapSecurity(input.secure),
		username: input.username,
		password: input.password,
	});
}

/** Why the import form's server is refused before anything connects (a local host, a port other than 993 or 143). */
export function importServerProblem(env: ImapImportEnv, input: Pick<ImapAccount, "host" | "port">): string | null {
	return mailServerHostProblem(input.host, input.port, mailHostPolicy(env, process.env.NODE_ENV), IMAP_PORTS);
}

export type ImapFetchResult = {
	messages: ImportMessageInput[];
	/** Messages in the folder when the batch was fetched. */
	total: number;
	/** Offset for the next batch, or null when no older messages remain. */
	nextOffset: number | null;
};

export async function fetchImapMessages(env: ImapImportEnv, input: ImapImportInput): Promise<ImapFetchResult> {
	const session = await openImportSession(env, input);
	try {
		await session.examine(input.folder);
		const batch = selectImapUidBatch(await session.searchUids(), input.limit, input.offset);
		const messages: ImportMessageInput[] = [];
		for (const uids of chunk(batch.uids, FETCH_CHUNK_SIZE)) {
			const fetched = await session.fetchMessages(uids);
			for (const uid of uids) {
				const message = fetched.get(uid);
				if (message) messages.push(importMessageFromImap(`${input.folder}-${uid}.eml`, message));
			}
		}
		return { messages, total: batch.total, nextOffset: batch.nextOffset };
	} finally {
		await session.close();
	}
}

export async function listImapFolders(env: ImapImportEnv, input: ImapAccount): Promise<string[]> {
	const session = await openImportSession(env, input);
	try {
		return await session.listMailboxNames();
	} finally {
		await session.close();
	}
}
