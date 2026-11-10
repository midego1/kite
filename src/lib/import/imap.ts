import { openImapSession } from "@/lib/imap/session";
import { IMAP_PORTS, imapLimits } from "@/lib/imap/protocol-utils";
import { MailServerRefusedError } from "@/lib/net/errors";
import { assertMailServerHost } from "@/lib/net/host-guard";
import { mailHostPolicy, mailServerHostProblem } from "@/lib/net/host-guard-utils";
import { fetchSegment, planSizedFetch } from "./capped-fetch";
import type { SignInGuard } from "./sign-in-limit";
import type { ImportMessageInput } from "./types";
import type { ImapImportInput } from "./imap-types";
import { imapSecurity, importMessageFromImap, selectImapUidBatch } from "./imap-utils";
import { planAccountFolders } from "./folder-mapping-utils";
import type { PlannedImportFolder } from "./folder-mapping-types";

/** Message bytes one request of the direct import route holds; it answers with the rest as `nextOffset`. */
const DIRECT_IMPORT_BYTES = 32 * 1024 * 1024;

type ImapImportEnv = Parameters<typeof openImapSession>[0];
type ImapAccount = Pick<ImapImportInput, "host" | "port" | "secure" | "username" | "password" | "accessToken">;

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
				...(input.accessToken ? { accessToken: input.accessToken } : {}),
			},
			{ signal },
		);
	return guard ? guard(input, open, signal) : open();
}

/** Why the import form's server is refused before anything connects (a local host, a port other than 993 or 143). */
export function importServerProblem(env: ImapImportEnv, input: Pick<ImapAccount, "host" | "port">): string | null {
	return mailServerHostProblem(input.host, input.port, mailHostPolicy(env, process.env.NODE_ENV), IMAP_PORTS);
}

/**
 * `importServerProblem` plus, on the Node server, every address the name resolves to: what saving a job checks, so a
 * name that resolves to a private address is refused when the job is created, not only when its first run connects.
 * Each run is checked again when it connects (the Node connector resolves and pins the address it vetted). With a
 * `guard` (the routes pass the import sign-in limit) a refused lookup counts like a failed sign-in, so saving jobs
 * cannot be used to map which names resolve to private addresses without limit; past it `SignInLimitError` is thrown.
 */
export async function importServerRefusal(
	env: ImapImportEnv & Parameters<typeof assertMailServerHost>[0],
	input: Pick<ImapAccount, "host" | "port">,
	guard?: SignInGuard,
): Promise<string | null> {
	const literal = importServerProblem(env, input);
	if (literal || !env.RESOLVE_HOST) return literal;
	const check = () => assertMailServerHost(env, input.host, input.port, IMAP_PORTS);
	try {
		await (guard ? guard(input, check) : check());
		return null;
	} catch (error) {
		if (error instanceof MailServerRefusedError) return error.message;
		throw error;
	}
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
		// Newest first, so that stopping early (the byte budget) leaves one contiguous older rest for `nextOffset`.
		const newestFirst = batch.uids.map(String).reverse();
		let held = 0;
		let consumed = 0;
		for (const segment of await planSizedFetch(session, newestFirst, limits.literalBytes, input.folder)) {
			// A message above the size limit is left out and named, instead of failing the whole batch.
			skipped.push(...segment.skipped);
			const fetched = await fetchSegment(session, segment, {});
			for (const uid of segment.uids) {
				const message = fetched.get(uid);
				if (!message) continue;
				held += message.raw.byteLength;
				messages.push(importMessageFromImap(`${input.folder}-${uid}.eml`, message));
			}
			consumed += segment.uids.length;
			if (held >= DIRECT_IMPORT_BYTES) break;
		}
		// What was not reached is older than what was: the next request starts after the messages that were.
		const first = (batch.nextOffset ?? batch.total) - batch.uids.length;
		const nextOffset = consumed < batch.uids.length ? first + consumed : batch.nextOffset;
		return { messages: messages.reverse(), total: batch.total, nextOffset, skipped };
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
