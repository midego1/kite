import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountFolders } from "@/db/schema/external-accounts";
import { getEmailAddress } from "@/lib/email/address";
import { parseRawHeaders } from "@/lib/email/raw-headers";
import { imapLimits, type ImapMessageSummary } from "@/lib/imap/protocol-utils";
import { openImapSession, type ImapSession } from "@/lib/imap/session";
import type { ImapFetchedMessage, ImapLimits } from "@/lib/imap/types";
import { createLogger } from "@/lib/logger.mjs";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { shortServerText } from "./connection-utils";
import { assertMailServerHost } from "./host-guard";
import type { ExternalAccountRow } from "./serialize-utils";
import { externalSyncRefusal } from "./sync-target";
import {
	baselineLastUid,
	commandCapMs,
	externalRawKey,
	fetchRange,
	findJunkFolder,
	planFetchSteps,
	planInboxSync,
	RESET_LOOKBACK_MS,
	resetLastUid,
	selectNewMessages,
	sourceFlags,
	SYNC_FETCH_CHUNK,
	SYNC_MAX_MESSAGE_BYTES,
	type InboxState,
	type SyncFolderRole,
	type SyncProblem,
} from "./sync-utils";

const logger = createLogger("external-sync");

/** A folder a run checks, by its name at the source. */
type SyncFolder = { name: string; role: SyncFolderRole };

const INBOX: SyncFolder = { name: "INBOX", role: "inbox" };
const FOLDER_NAMES: Record<SyncFolderRole, string> = { inbox: "Inbox", junk: "Spam folder" };
/** Reconnects one run may make to get past messages the server will not send; past it the run stops and retries. */
const MAX_REOPENS = 8;

/** A refusal Kite meets before the server answers anything; `config` unless said otherwise, never a retry. */
export class SyncRefusedError extends Error {
	constructor(
		message: string,
		readonly problem: SyncProblem["class"] = "config",
	) {
		super(message);
		this.name = "SyncRefusedError";
	}
}

export type RunOutcome = { delivered: number; skipped: number; more: boolean; reset: boolean; notes: string[] };

export const emptyOutcome = (): RunOutcome => ({ delivered: 0, skipped: 0, more: false, reset: false, notes: [] });

export type RunOptions = {
	budgetMs: number;
	clock: () => Date;
	/** The lease the run holds: the cursor only moves while it is still the account's. */
	lease: Date;
	/** Tests shrink the connection's limits to exercise the byte-bounded fetches. */
	limits?: Partial<ImapLimits>;
};

/** How long before its lease runs out a run stops, so it never outlives it (another run may take over then). */
const LEASE_MARGIN_MS = 2 * 60_000;

/** Signs in with the saved password, opened only for this run. */
async function openSession(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	limits: Partial<ImapLimits> | undefined,
): Promise<ImapSession> {
	let password: string | null;
	try {
		password = await openSetting(env, account.secret);
	} catch (error) {
		if (error instanceof SecretBoxError)
			throw new SyncRefusedError("The saved password can no longer be opened. Reconnect the account.", "auth");
		throw error;
	}
	if (!password)
		throw new SyncRefusedError("The saved password is no longer available. Reconnect the account.", "auth");
	await assertMailServerHost(env, account.imapHost, account.imapPort);
	try {
		return await openImapSession(
			env,
			{
				host: account.imapHost,
				port: account.imapPort,
				security: account.imapSecurity,
				username: account.username,
				password,
			},
			limits,
		);
	} catch (error) {
		// A server that echoes the password back must not get it into the account's error text.
		if (error instanceof Error && password && error.message.includes(password))
			error.message = error.message.split(password).join("•••");
		throw error;
	}
}

/**
 * The run's connection with one folder open (INBOX first, then the Spam folder). A FETCH that fails may leave the
 * connection in the middle of a literal, so after one the connection is replaced (`reopen`) before anything else is
 * asked; a server that cannot be reached again, or that rebuilt the folder meanwhile, ends the run with the cursor
 * where the last good step left it.
 */
class FolderConnection {
	private reopened = 0;
	/** A FETCH failed and the connection was not replaced yet: replace it before the next command. */
	private broken = false;
	private constructor(
		private readonly env: CloudflareEnv,
		private readonly account: ExternalAccountRow,
		private readonly limits: Partial<ImapLimits>,
		public session: ImapSession,
		public folder: SyncFolder,
		public state: InboxState,
	) {}

	static async open(env: CloudflareEnv, account: ExternalAccountRow, limits: Partial<ImapLimits>) {
		const session = await openSession(env, account, limits);
		try {
			return new FolderConnection(env, account, limits, session, INBOX, await session.examine(INBOX.name));
		} catch (error) {
			await session.close().catch(() => undefined);
			throw error;
		}
	}

	/** Opens another folder on the same connection; the folder's own UIDVALIDITY and UIDNEXT come with it. */
	async switchTo(folder: SyncFolder): Promise<void> {
		const session = await this.usable();
		this.state = await session.examine(folder.name);
		this.folder = folder;
	}

	/** Marks the connection unusable; the next `usable()` replaces it, and nothing does if no command follows. */
	fail(): void {
		this.broken = true;
	}

	/** The session, replaced first when the last FETCH failed. */
	async usable(): Promise<ImapSession> {
		if (this.broken) await this.reopen();
		return this.session;
	}

	private async reopen(): Promise<void> {
		this.reopened += 1;
		if (this.reopened > MAX_REOPENS)
			throw new Error("The mail server kept failing to send messages; Kite checks again later");
		await this.session.close().catch(() => undefined);
		this.session = await openSession(this.env, this.account, this.limits);
		this.broken = false;
		const state = await this.session.examine(this.folder.name);
		if (state.uidValidity !== this.state.uidValidity)
			throw new Error(
				`The provider rebuilt the ${FOLDER_NAMES[this.folder.role]} during the check; Kite will check it again`,
			);
	}

	close() {
		return this.session.close().catch(() => undefined);
	}
}

/** Thrown to end a run early, keeping the cursor where the last saved message left it. */
class StopRun extends Error {}

/** What every folder of one run shares: the connection's limits and when the run has to stop. */
type RunClock = { limits: ImapLimits; commandCap: number; started: number; deadline: number };

/**
 * One check of the account (spec §6.3): INBOX, then, when the account syncs its Spam folder and INBOX left nothing
 * for the next run, the provider's Spam folder on the same connection. Each folder has its own cursor, and its new
 * messages are handed to the inbound pipeline in byte-bounded steps before the cursor moves past them. The run stops
 * before a step when the account may no longer bring in mail, so nothing is fetched that delivery would refuse.
 */
export async function runSync(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	options: RunOptions,
	/** Filled as the run goes, so a run that fails half way still has its notes recorded. */
	outcome: RunOutcome = emptyOutcome(),
): Promise<RunOutcome> {
	const started = Date.now();
	const deadline = options.lease.getTime() - LEASE_MARGIN_MS;
	const base = { ...imapLimits(env.KITE_RUNTIME), ...options.limits };
	// No IMAP command started inside the budget may run past the deadline, so the run never outlives its lease.
	const commandCap = commandCapMs({ deadline, started, budgetMs: options.budgetMs, commandMaxMs: base.commandMaxMs });
	const limits = { ...base, commandMaxMs: commandCap, commandTimeoutMs: Math.min(base.commandTimeoutMs, commandCap) };
	const clock: RunClock = { limits, commandCap, started, deadline };
	const connection = await FolderConnection.open(env, account, limits);
	try {
		await syncFolder(env, connection, account, options, outcome, clock);
		if (account.syncJunk && !outcome.more && !outOfTime(options, clock)) {
			const junk = await openJunkFolder(env, connection, account);
			if (junk) await syncFolder(env, connection, account, options, outcome, clock);
		}
		return outcome;
	} finally {
		await connection.close();
	}
}

const outOfTime = (options: RunOptions, clock: RunClock) =>
	Date.now() - clock.started > options.budgetMs || Date.now() + clock.commandCap > clock.deadline;

/**
 * Opens the account's Spam folder on the run's connection: the one its cursor names, or, the first time (or after the
 * provider renamed it), the one its `LIST` marks `\Junk` or names like a Spam folder. False when there is none.
 */
async function openJunkFolder(
	env: CloudflareEnv,
	connection: FolderConnection,
	account: ExternalAccountRow,
): Promise<boolean> {
	const db = getDb(env);
	const [known] = await db
		.select({ name: externalAccountFolders.name })
		.from(externalAccountFolders)
		.where(and(eq(externalAccountFolders.accountId, account.id), eq(externalAccountFolders.role, "junk")))
		.limit(1);
	if (known) {
		try {
			await connection.switchTo({ name: known.name, role: "junk" });
			return true;
		} catch {
			// Renamed or gone at the source. The answer may have left the connection unusable, so it is replaced before
			// the folders are listed (a server that cannot be reached again ends the run there).
			connection.fail();
		}
	}
	const name = findJunkFolder(await (await connection.usable()).listMailboxes());
	if (!name || name === known?.name) {
		logger.info("external.sync.junk_missing", { accountId: account.id });
		return false;
	}
	// A renamed Spam folder is a new folder: its cursor starts again from a baseline.
	if (known)
		await db
			.delete(externalAccountFolders)
			.where(and(eq(externalAccountFolders.accountId, account.id), eq(externalAccountFolders.role, "junk")));
	await connection.switchTo({ name, role: "junk" });
	return true;
}

/** The folder the connection has open, from its cursor: a baseline, nothing new, new messages or a reset. */
async function syncFolder(
	env: CloudflareEnv,
	connection: FolderConnection,
	account: ExternalAccountRow,
	options: RunOptions,
	outcome: RunOutcome,
	clock: RunClock,
): Promise<void> {
	const { state, folder } = connection;
	const db = getDb(env);
	const [cursor] = await db
		.select()
		.from(externalAccountFolders)
		.where(and(eq(externalAccountFolders.accountId, account.id), eq(externalAccountFolders.name, folder.name)))
		.limit(1);
	const plan = planInboxSync(cursor ? { uidValidity: cursor.uidvalidity, lastUid: cursor.lastUid } : null, state);
	const save = (lastUid: number) => saveCursor(env, account.id, folder, state, lastUid, options);
	if (plan.kind === "baseline") {
		const uids =
			state.uidNext === null && state.exists !== 0 ? (await connection.session.searchUids()).map(Number) : [];
		await save(baselineLastUid(state.uidNext, uids));
		return;
	}
	if (plan.kind === "unchanged") {
		await save(cursor!.lastUid!);
		return;
	}
	let lastUid = plan.kind === "fetch" ? plan.fromUid - 1 : 0;
	if (plan.kind === "reset") {
		const since = new Date((account.lastSuccessAt ?? options.clock()).getTime() - RESET_LOOKBACK_MS);
		const recent = state.exists === 0 ? [] : await connection.session.searchUidsSince(since);
		lastUid = resetLastUid(recent, state.uidNext);
		await save(lastUid);
		outcome.reset = true;
		outcome.notes.push(`The provider reset the ${FOLDER_NAMES[folder.role]}; Kite checked the last two days again.`);
	}
	const range = fetchRange(state, lastUid);
	if (!range) {
		await save(lastUid);
		return;
	}
	const { take, more } = selectNewMessages(await connection.session.fetchSummaries(range.from, range.to), lastUid);
	outcome.more = more;
	const steps = planFetchSteps(take, {
		maxCount: SYNC_FETCH_CHUNK,
		// RFC822.SIZE is the literal's size; a tenth is left for servers that count differently.
		maxBytes: Math.floor(clock.limits.fetchBatchBytes * 0.9),
		maxMessageBytes: Math.min(SYNC_MAX_MESSAGE_BYTES, clock.limits.literalBytes),
	});
	const progress: Progress = {
		outOfTime: () => outOfTime(options, clock),
		// Checked right before the cursor moves: a refusal that began while messages were being handed on keeps
		// them before the cursor, so delivery's refusal (which moves the cursor back) can never be overwritten.
		save: async (uid) => {
			await assertMayDeliver(env, account);
			await save(uid);
		},
	};
	try {
		for (const step of steps) {
			if (progress.outOfTime()) {
				outcome.more = true;
				break;
			}
			await assertMayDeliver(env, account);
			if (step.kind === "skip") skipTooLarge(step.entry, outcome);
			else await fetchStep(env, connection, account, step.entries, outcome, progress);
			await progress.save(step.kind === "skip" ? step.entry.uid : step.entries[step.entries.length - 1].uid);
		}
	} catch (error) {
		if (!(error instanceof StopRun)) throw error;
		outcome.more = error.message === "out_of_time";
	}
}

/** What a step needs from the run: whether time is up, and how to move the cursor (refusal checked first). */
type Progress = { outOfTime: () => boolean; save: (uid: number) => Promise<void> };

/**
 * Stops the run when the account may no longer bring in mail (spec §6.4): a mailbox the owner lost access to is a
 * configuration problem; a refusal of the switch or the permission (or a disabled owner) just ends the run.
 */
async function assertMayDeliver(env: CloudflareEnv, account: ExternalAccountRow): Promise<void> {
	const refusal = await externalSyncRefusal(env, account);
	if (refusal === "mailbox_access")
		throw new SyncRefusedError(
			"Kite can no longer deliver into this account's mailbox. Edit the account to choose another one.",
		);
	if (refusal) throw new StopRun("refused");
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const receivedOn = (entry: ImapMessageSummary) =>
	entry.internalDate ? ` received ${entry.internalDate.toISOString().slice(0, 10)}` : "";

function skipTooLarge(entry: ImapMessageSummary, outcome: RunOutcome) {
	outcome.skipped += 1;
	outcome.notes.push(
		`Skipped a ${megabytes(entry.size!)} message${receivedOn(entry)}: Kite receives messages up to ${megabytes(SYNC_MAX_MESSAGE_BYTES)}.`,
	);
}

/**
 * Fetches one step's bodies and hands them on. When the step's FETCH fails (a server that will not send one of the
 * messages, a literal above the connection's limits), the connection is replaced and each message is fetched alone, so
 * one bad message cannot hold back the rest, nor the cursor.
 */
async function fetchStep(
	env: CloudflareEnv,
	connection: FolderConnection,
	account: ExternalAccountRow,
	entries: ImapMessageSummary[],
	outcome: RunOutcome,
	progress: Progress,
): Promise<void> {
	// A reconnect that fails (the server is gone, the run used up its reconnects) ends the run; only the FETCH itself
	// failing is the message's problem.
	const session = await connection.usable();
	let bodies: Map<string, ImapFetchedMessage>;
	try {
		bodies = await session.fetchMessages(entries.map((entry) => String(entry.uid)));
	} catch (error) {
		connection.fail();
		// Each message alone, the cursor saved after each one, so a step full of bad messages still moves forward even
		// when the run's reconnects run out half way.
		for (const [index, entry] of entries.entries()) {
			if (index > 0 && progress.outOfTime()) throw new StopRun("out_of_time");
			await fetchAlone(env, connection, account, entry, outcome, entries.length === 1 ? error : null);
			if (index < entries.length - 1) await progress.save(entry.uid);
		}
		return;
	}
	let missing = 0;
	for (const entry of entries) {
		const message = bodies.get(String(entry.uid));
		if (message) await handOn(env, account, connection, entry, message, outcome);
		else missing += 1;
	}
	if (missing) noteMissing(missing, outcome);
}

function noteMissing(count: number, outcome: RunOutcome) {
	outcome.skipped += count;
	outcome.notes.push(
		count === 1
			? "A message was deleted at the provider before Kite fetched it."
			: `${count} messages were deleted at the provider before Kite fetched them.`,
	);
}

/**
 * One message on its own: tried twice (with a fresh connection after a failure); a message the server still will not
 * send is skipped and named in the account's problems, and the cursor moves past it. A connection a failure left
 * unusable is only replaced when another command follows.
 */
async function fetchAlone(
	env: CloudflareEnv,
	connection: FolderConnection,
	account: ExternalAccountRow,
	entry: ImapMessageSummary,
	outcome: RunOutcome,
	earlier: unknown,
): Promise<void> {
	let failure = earlier;
	for (let attempt = earlier ? 1 : 0; attempt < 2; attempt += 1) {
		const session = await connection.usable();
		let bodies: Map<string, ImapFetchedMessage>;
		try {
			bodies = await session.fetchMessages([String(entry.uid)]);
		} catch (error) {
			failure = error;
			connection.fail();
			continue;
		}
		const message = bodies.get(String(entry.uid));
		if (message) await handOn(env, account, connection, entry, message, outcome);
		else noteMissing(1, outcome);
		return;
	}
	outcome.skipped += 1;
	const reason = failure instanceof Error && failure.message ? `: ${shortServerText(failure.message)}` : "";
	outcome.notes.push(`Skipped a message${receivedOn(entry)} the server would not send${reason}`);
}

/** The raw message at its deterministic key in the Mail store, then one `INBOUND_QUEUE` message with its flags. */
async function handOn(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	{ state, folder: { role } }: Pick<FolderConnection, "state" | "folder">,
	entry: ImapMessageSummary,
	message: ImapFetchedMessage,
	outcome: RunOutcome,
): Promise<void> {
	const key = externalRawKey(account.id, state.uidValidity, entry.uid, role);
	await env.BUCKET.put(key, message.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { accountId: account.id },
	});
	await env.INBOUND_QUEUE.send({
		from: envelopeSender(message.raw),
		to: account.address,
		rawR2Key: key,
		source: {
			kind: "external",
			accountId: account.id,
			...sourceFlags(message.flags.length ? message.flags : entry.flags),
		},
	});
	outcome.delivered += 1;
}

/** The envelope sender the provider recorded (`Return-Path`, written at its final delivery), or empty. */
function envelopeSender(raw: ArrayBuffer): string {
	return getEmailAddress(parseRawHeaders(raw).get("return-path")?.[0] ?? "") || "";
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Where a folder stands, written only while the run still holds its lease (one statement), so a run that outlived its
 * lease can never move the cursor of the run that took over.
 */
async function saveCursor(
	env: CloudflareEnv,
	accountId: string,
	folder: SyncFolder,
	state: InboxState,
	lastUid: number,
	options: Pick<RunOptions, "clock" | "lease">,
): Promise<void> {
	await getDb(env).run(sql`
		INSERT INTO ${externalAccountFolders} (account_id, name, role, uidvalidity, uidnext, last_uid, last_checked_at)
		SELECT ${accountId}, ${folder.name}, ${folder.role}, ${state.uidValidity}, ${state.uidNext}, ${lastUid}, ${seconds(options.clock())}
		WHERE EXISTS (SELECT 1 FROM external_accounts WHERE id = ${accountId} AND lease_until = ${seconds(options.lease)})
		ON CONFLICT (account_id, name) DO UPDATE SET uidvalidity = excluded.uidvalidity, uidnext = excluded.uidnext,
			last_uid = excluded.last_uid, last_checked_at = excluded.last_checked_at
	`);
}
