import { openMailSocket } from "@/lib/net/connect";
import { MailServerRefusedError } from "@/lib/net/errors";
import { allowsPlainText, mailHostPolicy } from "@/lib/net/host-guard-utils";
import { ImapConnection, type ImapConnectionOptions } from "./connection";
import {
	chooseAuthMethod,
	imapLimits,
	imapSearchDate,
	IMAP_PORTS,
	parseListLine,
	parseListMailboxName,
	parseStatusLine,
	parseExists,
	parseHighestModseq,
	parseUidNext,
	parseUidValidity,
	type ImapListedMailbox,
	type ImapMessageSummary,
	parseFetchSummaries,
	parseSearchUids,
	plainAuthToken,
	planStartTls,
	quoteImapString,
} from "./protocol-utils";
import type { ImapFetchedMessage, ImapLogin } from "./types";

/** What opening a folder said; a field is null when the server did not say it. */
type ImapFolderState = {
	uidValidity: number | null;
	uidNext: number | null;
	exists: number | null;
	/** CONDSTORE's `HIGHESTMODSEQ`: changes whenever a flag in the folder does. */
	highestModseq: string | null;
};

export type ImapSession = {
	/** The capabilities the server announced after sign-in (upper-case), such as `X-GM-EXT-1` on Gmail. */
	readonly capabilities: readonly string[];
	/** Opens `folder` read-only. */
	examine(folder: string): Promise<ImapFolderState>;
	/**
	 * Opens `folder` read-write, the only command that lets a session change anything; refused when the server opens
	 * it read-only. Only two-way sync (spec §6.8) calls it, and only when the account's owner turned that on.
	 */
	select(folder: string): Promise<ImapFolderState>;
	searchUids(): Promise<string[]>;
	/** The UIDs of the open folder's messages received on or after `date`'s day (`UID SEARCH SINCE`). */
	searchUidsSince(date: Date): Promise<number[]>;
	/**
	 * Flags, INTERNALDATE and size of the open folder's messages with UIDs from `fromUid` to `toUid` (`UID FETCH n:m …`,
	 * or `n:*` when `toUid` is null), without bodies. A server answers `n:*` with the highest UID even when it is below
	 * `n`; the caller drops what it has seen.
	 */
	fetchSummaries(fromUid: number, toUid?: number | null): Promise<ImapMessageSummary[]>;
	/**
	 * UID and size only (`FETCH n:m (UID RFC822.SIZE)`, no bodies) of the open folder's messages with sequence numbers
	 * from `fromSeq` to `toSeq`: about 40 bytes of answer per message, which is how an import measures a folder whose
	 * server has no STATUS=SIZE.
	 */
	fetchSizes(fromSeq: number, toSeq: number): Promise<ImapMessageSummary[]>;
	/** Flags alone (`UID FETCH n:m (UID FLAGS)`) of the open folder's messages from `fromUid` to `toUid`. */
	fetchFlags(fromUid: number, toUid: number): Promise<ImapMessageSummary[]>;
	fetchMessages(
		uids: string[],
		options?: { gmailLabels?: boolean; messageIdHeader?: boolean },
	): Promise<Map<string, ImapFetchedMessage>>;
	/** Adds (`+`) or removes (`-`) `flags` on the open folder's messages, without untagged answers. */
	storeFlags(uids: readonly number[], change: "+" | "-", flags: readonly string[]): Promise<void>;
	/** `UID MOVE` to `folder` (its name as LIST returned it); needs the MOVE capability. */
	moveMessages(uids: readonly number[], folder: string): Promise<void>;
	/** `UID COPY` to `folder`. */
	copyMessages(uids: readonly number[], folder: string): Promise<void>;
	/** `UID EXPUNGE` of exactly `uids` (UIDPLUS); a plain EXPUNGE, which takes other clients' messages too, has no method. */
	expungeMessages(uids: readonly number[]): Promise<void>;
	listMailboxNames(): Promise<string[]>;
	/**
	 * Every mailbox with its attributes, asking for special-use attributes (`LIST "" "*" RETURN (SPECIAL-USE)`)
	 * where the server offers SPECIAL-USE or LIST-EXTENDED; plain LIST otherwise.
	 */
	listMailboxes(): Promise<ImapListedMailbox[]>;
	/** MESSAGES, UIDNEXT, UIDVALIDITY and, with STATUS=SIZE, SIZE of one mailbox; null when the server refuses. */
	status(folder: string): Promise<ReturnType<typeof parseStatusLine>>;
	/** Whether `folder` holds a message with this Message-ID header (`UID SEARCH HEADER Message-ID`). */
	hasMessageId(folder: string, messageId: string): Promise<boolean>;
	/** Adds one message to `folder` with `flags` (`\\Seen`); the only write at the source (spec §7.4). */
	append(folder: string, flags: readonly string[], raw: Uint8Array): Promise<void>;
	close(): Promise<void>;
};

type ImapEnv = Parameters<typeof openMailSocket>[0];

/**
 * Connects, makes sure the connection is encrypted (implicit TLS, or STARTTLS before anything else is sent) and
 * signs in with `AUTHENTICATE PLAIN` or `LOGIN`. Credentials are never sent over a plain connection, except to a
 * loopback fake under `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK` outside production.
 */
export async function openImapSession(
	env: ImapEnv,
	login: ImapLogin,
	options: ImapConnectionOptions & { signal?: AbortSignal } = {},
): Promise<ImapSession> {
	const { signal, ...limits } = options;
	signal?.throwIfAborted();
	const socket = await openMailSocket(env, login, IMAP_PORTS);
	const imap = new ImapConnection(socket, { ...imapLimits(env.KITE_RUNTIME), ...limits });
	const abort = () => void imap.close().catch(() => undefined);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		await signIn(imap, login, allowsPlainText(login.host, mailHostPolicy(env, process.env.NODE_ENV)));
		// Servers announce more after sign-in (Gmail's X-GM-EXT-1, SPECIAL-USE), and not always in the OK.
		await imap.capability();
	} catch (error) {
		signal?.removeEventListener("abort", abort);
		await imap.close();
		throw error;
	}
	const folderState = (lines: readonly string[]): ImapFolderState => ({
		uidValidity: parseUidValidity(lines),
		uidNext: parseUidNext(lines),
		exists: parseExists(lines),
		highestModseq: parseHighestModseq(lines),
	});
	return {
		get capabilities() {
			return imap.capabilities;
		},
		async examine(folder) {
			return folderState(await imap.command(`EXAMINE ${quoteImapString(folder)}`));
		},
		async select(folder) {
			const lines = await imap.command(`SELECT ${quoteImapString(folder)}`);
			if (lines.some((line) => /\[READ-ONLY\]/i.test(line)))
				throw new Error("IMAP SELECT failed: the server opened the folder read-only");
			return folderState(lines);
		},
		async searchUids() {
			const lines = await imap.command("UID SEARCH ALL");
			return lines.flatMap(parseSearchUids);
		},
		async searchUidsSince(date) {
			const lines = await imap.command(`UID SEARCH SINCE ${imapSearchDate(date)}`);
			return lines.flatMap(parseSearchUids).map(Number);
		},
		async fetchSummaries(fromUid, toUid = null) {
			const from = Math.max(1, Math.floor(fromUid));
			const to = toUid === null ? "*" : Math.max(from, Math.floor(toUid));
			const lines = await imap.command(`UID FETCH ${from}:${to} (UID FLAGS INTERNALDATE RFC822.SIZE)`);
			return parseFetchSummaries(lines);
		},
		async fetchSizes(fromSeq, toSeq) {
			const from = Math.max(1, Math.floor(fromSeq));
			const to = Math.max(from, Math.floor(toSeq));
			const lines = await imap.command(`FETCH ${from}:${to} (UID RFC822.SIZE)`);
			return parseFetchSummaries(lines);
		},
		async fetchFlags(fromUid, toUid) {
			const lines = await imap.command(`UID FETCH ${fromUid}:${toUid} (UID FLAGS)`);
			return parseFetchSummaries(lines);
		},
		fetchMessages: (uids, options) => imap.fetchMessages(uids, options),
		async storeFlags(uids, change, flags) {
			await imap.command(`UID STORE ${uids.join(",")} ${change}FLAGS.SILENT (${flags.join(" ")})`, "IMAP STORE failed");
		},
		async moveMessages(uids, folder) {
			await imap.command(`UID MOVE ${uids.join(",")} ${quoteImapString(folder)}`, "IMAP MOVE failed");
		},
		async copyMessages(uids, folder) {
			await imap.command(`UID COPY ${uids.join(",")} ${quoteImapString(folder)}`, "IMAP COPY failed");
		},
		async expungeMessages(uids) {
			await imap.command(`UID EXPUNGE ${uids.join(",")}`, "IMAP EXPUNGE failed");
		},
		async listMailboxes() {
			const extended = imap.capabilities.some((name) => name === "SPECIAL-USE" || name === "LIST-EXTENDED");
			const lines = await imap.command(extended ? 'LIST "" "*" RETURN (SPECIAL-USE)' : 'LIST "" "*"');
			const seen = new Set<string>();
			return lines
				.map(parseListLine)
				.filter((entry): entry is ImapListedMailbox => !!entry && !seen.has(entry.name) && !!seen.add(entry.name));
		},
		async status(folder) {
			const items = imap.capabilities.includes("STATUS=SIZE")
				? "MESSAGES UIDNEXT UIDVALIDITY SIZE"
				: "MESSAGES UIDNEXT UIDVALIDITY";
			const lines = await imap.command(`STATUS ${quoteImapString(folder)} (${items})`).catch(() => null);
			return lines?.map(parseStatusLine).find((entry) => entry) ?? null;
		},
		append: (folder, flags, raw) => imap.appendMessage(folder, flags, raw),
		async hasMessageId(folder, messageId) {
			await imap.command(`EXAMINE ${quoteImapString(folder)}`);
			const lines = await imap.command(`UID SEARCH HEADER Message-ID ${quoteImapString(messageId)}`);
			return lines.flatMap(parseSearchUids).length > 0;
		},
		async listMailboxNames() {
			const lines = await imap.command('LIST "" "*"');
			return Array.from(new Set(lines.map(parseListMailboxName).filter((name): name is string => !!name)));
		},
		async close() {
			signal?.removeEventListener("abort", abort);
			if (!signal?.aborted) await imap.command("LOGOUT").catch(() => undefined);
			await imap.close();
		},
	};
}

async function signIn(imap: ImapConnection, login: ImapLogin, plainTextAllowed: boolean): Promise<void> {
	const preauth = await imap.readGreeting();
	const capabilities = imap.capabilities.length ? imap.capabilities : await imap.capability();
	const plan = planStartTls({ security: login.security, capabilities, preauth, plainTextAllowed });
	if (plan.action === "refuse") throw new MailServerRefusedError(plan.reason);
	if (plan.action === "starttls") {
		await imap.startTls();
		await imap.capability();
	}
	if (preauth) return;
	const method = chooseAuthMethod(imap.capabilities);
	if (!method) throw new MailServerRefusedError("The IMAP server does not accept a password sign-in");
	if (method === "login") {
		await imap.login(login.username, login.password);
		return;
	}
	await imap.authenticatePlain(plainAuthToken(login.username, login.password), method === "plain-ir");
}
