import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountFolders } from "@/db/schema/external-accounts";
import { getEmailAddress } from "@/lib/email/address";
import { parseRawHeaders } from "@/lib/email/raw-headers";
import { imapLimits, type ImapMessageSummary } from "@/lib/imap/protocol-utils";
import { openImapSession, type ImapSession } from "@/lib/imap/session";
import type { ImapFetchedMessage, ImapLimits } from "@/lib/imap/types";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { shortServerText } from "./connection-utils";
import { assertMailServerHost } from "./host-guard";
import type { ExternalAccountRow } from "./serialize-utils";
import { externalSyncRefusal } from "./sync-target";
import {
	baselineLastUid,
	externalRawKey,
	fetchRange,
	planFetchSteps,
	planInboxSync,
	RESET_LOOKBACK_MS,
	resetLastUid,
	selectNewMessages,
	sourceFlags,
	SYNC_FETCH_CHUNK,
	SYNC_MAX_MESSAGE_BYTES,
	type InboxState,
	type SyncProblem,
} from "./sync-utils";

const INBOX = "INBOX";
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

export type RunOptions = {
	budgetMs: number;
	clock: () => Date;
	/** The lease the run holds: the cursor only moves while it is still the account's. */
	lease: Date;
	/** Tests shrink the connection's limits to exercise the byte-bounded fetches. */
	limits?: Partial<ImapLimits>;
};

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
 * The run's connection with INBOX open. A FETCH that fails may leave the connection in the middle of a literal, so
 * after one the connection is replaced (`reopen`) before anything else is asked; a server that cannot be reached
 * again, or that rebuilt INBOX meanwhile, ends the run with the cursor where the last good step left it.
 */
class InboxConnection {
	private reopened = 0;
	private constructor(
		private readonly env: CloudflareEnv,
		private readonly account: ExternalAccountRow,
		private readonly limits: Partial<ImapLimits> | undefined,
		public session: ImapSession,
		public readonly state: InboxState,
	) {}

	static async open(env: CloudflareEnv, account: ExternalAccountRow, limits: Partial<ImapLimits> | undefined) {
		const session = await openSession(env, account, limits);
		try {
			return new InboxConnection(env, account, limits, session, await session.examine(INBOX));
		} catch (error) {
			await session.close().catch(() => undefined);
			throw error;
		}
	}

	async reopen(): Promise<void> {
		this.reopened += 1;
		if (this.reopened > MAX_REOPENS)
			throw new Error("The mail server kept failing to send messages; Kite will try again later");
		await this.session.close().catch(() => undefined);
		this.session = await openSession(this.env, this.account, this.limits);
		const state = await this.session.examine(INBOX);
		if (state.uidValidity !== this.state.uidValidity)
			throw new Error("The provider rebuilt the Inbox during the check; Kite will check it again");
	}

	close() {
		return this.session.close().catch(() => undefined);
	}
}

/**
 * One check of INBOX (spec §6.3): the plan from the cursor, then the new messages in byte-bounded steps, each handed
 * to the inbound pipeline before the cursor moves past it. The run stops before a step when the account may no longer
 * bring in mail, so nothing is fetched that delivery would refuse.
 */
export async function runSync(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	options: RunOptions,
): Promise<RunOutcome> {
	const connection = await InboxConnection.open(env, account, options.limits);
	try {
		const { state } = connection;
		const db = getDb(env);
		const [cursor] = await db
			.select()
			.from(externalAccountFolders)
			.where(and(eq(externalAccountFolders.accountId, account.id), eq(externalAccountFolders.name, INBOX)))
			.limit(1);
		const plan = planInboxSync(cursor ? { uidValidity: cursor.uidvalidity, lastUid: cursor.lastUid } : null, state);
		const outcome: RunOutcome = { delivered: 0, skipped: 0, more: false, reset: false, notes: [] };
		const save = (lastUid: number) => saveCursor(env, account.id, state, lastUid, options);
		if (plan.kind === "baseline") {
			const uids =
				state.uidNext === null && state.exists !== 0 ? (await connection.session.searchUids()).map(Number) : [];
			await save(baselineLastUid(state.uidNext, uids));
			return outcome;
		}
		if (plan.kind === "unchanged") {
			await save(cursor!.lastUid!);
			return outcome;
		}
		let lastUid = plan.kind === "fetch" ? plan.fromUid - 1 : 0;
		if (plan.kind === "reset") {
			const since = new Date((account.lastSuccessAt ?? options.clock()).getTime() - RESET_LOOKBACK_MS);
			const recent = state.exists === 0 ? [] : await connection.session.searchUidsSince(since);
			lastUid = resetLastUid(recent, state.uidNext);
			await save(lastUid);
			outcome.reset = true;
			outcome.notes.push("The provider reset the Inbox; Kite checked the last two days again.");
		}
		const range = fetchRange(state, lastUid);
		if (!range) {
			await save(lastUid);
			return outcome;
		}
		const { take, more } = selectNewMessages(await connection.session.fetchSummaries(range.from, range.to), lastUid);
		outcome.more = more;
		const limits = { ...imapLimits(env.KITE_RUNTIME), ...options.limits };
		const steps = planFetchSteps(take, {
			maxCount: SYNC_FETCH_CHUNK,
			// RFC822.SIZE is the literal's size; a tenth is left for servers that count differently.
			maxBytes: Math.floor(limits.fetchBatchBytes * 0.9),
			maxMessageBytes: Math.min(SYNC_MAX_MESSAGE_BYTES, limits.literalBytes),
		});
		const started = Date.now();
		for (const step of steps) {
			if (Date.now() - started > options.budgetMs) {
				outcome.more = true;
				break;
			}
			const refusal = await externalSyncRefusal(env, account);
			if (refusal === "mailbox_access")
				throw new SyncRefusedError(
					"Kite can no longer deliver into this account's mailbox. Edit the account to choose another one.",
				);
			// Refused meanwhile (switch, permission, disabled owner): stop before fetching what delivery would refuse.
			if (refusal) {
				outcome.more = false;
				break;
			}
			if (step.kind === "skip") skipTooLarge(step.entry, outcome);
			else await fetchStep(env, connection, account, step.entries, outcome);
			lastUid = step.kind === "skip" ? step.entry.uid : step.entries[step.entries.length - 1].uid;
			await save(lastUid);
		}
		return outcome;
	} finally {
		await connection.close();
	}
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
	connection: InboxConnection,
	account: ExternalAccountRow,
	entries: ImapMessageSummary[],
	outcome: RunOutcome,
): Promise<void> {
	let bodies: Map<string, ImapFetchedMessage>;
	try {
		bodies = await connection.session.fetchMessages(entries.map((entry) => String(entry.uid)));
	} catch (error) {
		await connection.reopen();
		if (entries.length === 1) {
			await fetchAlone(env, connection, account, entries[0], outcome, error);
			return;
		}
		for (const entry of entries) await fetchAlone(env, connection, account, entry, outcome, null);
		return;
	}
	let missing = 0;
	for (const entry of entries) {
		const message = bodies.get(String(entry.uid));
		if (message) await handOn(env, account, connection.state, entry, message, outcome);
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
 * send is skipped and named in the account's problems, and the cursor moves past it.
 */
async function fetchAlone(
	env: CloudflareEnv,
	connection: InboxConnection,
	account: ExternalAccountRow,
	entry: ImapMessageSummary,
	outcome: RunOutcome,
	earlier: unknown,
): Promise<void> {
	let failure = earlier;
	for (let attempt = earlier ? 1 : 0; attempt < 2; attempt += 1) {
		let bodies: Map<string, ImapFetchedMessage>;
		try {
			bodies = await connection.session.fetchMessages([String(entry.uid)]);
		} catch (error) {
			failure = error;
			await connection.reopen();
			continue;
		}
		const message = bodies.get(String(entry.uid));
		if (message) await handOn(env, account, connection.state, entry, message, outcome);
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
	state: InboxState,
	entry: ImapMessageSummary,
	message: ImapFetchedMessage,
	outcome: RunOutcome,
): Promise<void> {
	const key = externalRawKey(account.id, state.uidValidity, entry.uid);
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
 * Where INBOX stands, written only while the run still holds its lease (one statement), so a run that outlived its
 * lease can never move the cursor of the run that took over.
 */
async function saveCursor(
	env: CloudflareEnv,
	accountId: string,
	state: InboxState,
	lastUid: number,
	options: Pick<RunOptions, "clock" | "lease">,
): Promise<void> {
	await getDb(env).run(sql`
		INSERT INTO ${externalAccountFolders} (account_id, name, role, uidvalidity, uidnext, last_uid, last_checked_at)
		SELECT ${accountId}, ${INBOX}, 'inbox', ${state.uidValidity}, ${state.uidNext}, ${lastUid}, ${seconds(options.clock())}
		WHERE EXISTS (SELECT 1 FROM external_accounts WHERE id = ${accountId} AND lease_until = ${seconds(options.lease)})
		ON CONFLICT (account_id, name) DO UPDATE SET uidvalidity = excluded.uidvalidity, uidnext = excluded.uidnext,
			last_uid = excluded.last_uid, last_checked_at = excluded.last_checked_at
	`);
}
