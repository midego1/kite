import { openImapSession } from "@/lib/imap/session";
import { IMAP_PORTS, imapLimits } from "@/lib/imap/protocol-utils";
import { mailHostPolicy, mailServerHostProblem } from "@/lib/net/host-guard-utils";
import { fetchWithinSizeCap } from "./capped-fetch";
import type { SignInGuard } from "./sign-in-limit";
import type { ImportMessageInput } from "./types";
import type { ImapImportInput } from "./imap-types";
import { chunk, imapSecurity, importMessageFromImap, selectImapUidBatch } from "./imap-utils";
import { planAccountFolders } from "./folder-mapping-utils";
import type { PlannedImportFolder } from "./folder-mapping-types";

/** Messages fetched per UID FETCH command. */
const FETCH_CHUNK_SIZE = 25;

type ImapImportEnv = Parameters<typeof openImapSession>[0];
type ImapAccount = Pick<ImapImportInput, "host" | "port" | "secure" | "username" | "password">;

/**
 * Signs in to the source account of an import (`secure` off means STARTTLS, never plain text). With a `guard` (the
 * routes pass one) the sign-in counts against the user's limit on failed sign-ins and is refused past it.
 */
export function openImportSession(env: ImapImportEnv, input: ImapAccount, signal?: AbortSignal, guard?: SignInGuard) {
	const open = () =>
		openImapSession(
			env,
			{
				host: input.host,
				port: input.port,
				security: imapSecurity(input.secure),
				username: input.username,
				password: input.password,
			},
			{ signal },
		);
	return guard ? guard(input, open) : open();
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
	/** Messages left out for their size, each named with its folder, UID and size. */
	skipped: string[];
};

export async function fetchImapMessages(
	env: ImapImportEnv,
	input: ImapImportInput,
	guard?: SignInGuard,
): Promise<ImapFetchResult> {
	const session = await openImportSession(env, input, undefined, guard);
	try {
		await session.examine(input.folder);
		const batch = selectImapUidBatch(await session.searchUids(), input.limit, input.offset);
		const messages: ImportMessageInput[] = [];
		const skipped: string[] = [];
		const limits = imapLimits(env.KITE_RUNTIME);
		for (const uids of chunk(batch.uids, FETCH_CHUNK_SIZE)) {
			// A message above the size limit is left out and named, instead of failing the whole batch.
			const capped = await fetchWithinSizeCap(session, uids, {}, limits, input.folder);
			skipped.push(...capped.skipped);
			for (const uid of uids) {
				const message = capped.fetched.get(uid);
				if (message) messages.push(importMessageFromImap(`${input.folder}-${uid}.eml`, message));
			}
		}
		return { messages, total: batch.total, nextOffset: batch.nextOffset, skipped };
	} finally {
		await session.close();
	}
}

export async function listImapFolders(env: ImapImportEnv, input: ImapAccount, guard?: SignInGuard): Promise<string[]> {
	const session = await openImportSession(env, input, undefined, guard);
	try {
		return await session.listMailboxNames();
	} finally {
		await session.close();
	}
}

export type AccountImportPlan = {
	/** Gmail (`X-GM-EXT-1`): All Mail is copied once and each message filed by its labels. */
	gmail: boolean;
	folders: (PlannedImportFolder & { messages: number | null; bytes: number | null })[];
};

/**
 * The mapping table of a whole-account import: the source's folders with their proposed role and destination, and
 * each one's message count and size from STATUS (the size only where the server offers STATUS=SIZE).
 */
export async function planAccountImport(
	env: ImapImportEnv,
	input: ImapAccount,
	guard?: SignInGuard,
): Promise<AccountImportPlan> {
	const session = await openImportSession(env, input, undefined, guard);
	try {
		const gmail = session.capabilities.includes("X-GM-EXT-1");
		const planned = planAccountFolders(await session.listMailboxes(), { gmail });
		const folders: AccountImportPlan["folders"] = [];
		for (const folder of planned) {
			const status = await session.status(folder.sourceName);
			folders.push({ ...folder, messages: status?.messages ?? null, bytes: status?.size ?? null });
		}
		return { gmail, folders };
	} finally {
		await session.close();
	}
}
