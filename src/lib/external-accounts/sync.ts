import { and, asc, eq, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountFolders, externalAccounts } from "@/db/schema/external-accounts";
import { getEmailAddress } from "@/lib/email/address";
import { parseRawHeaders } from "@/lib/email/raw-headers";
import { openImapSession, type ImapSession } from "@/lib/imap/session";
import type { ImapMessageSummary } from "@/lib/imap/protocol-utils";
import { createLogger } from "@/lib/logger.mjs";
import { recordMetric } from "@/lib/metrics.mjs";
import { MailServerRefusedError } from "@/lib/net/errors";
import { notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { auditExternalAccount } from "./audit";
import { externalAccountTablesReady } from "./errors";
import { assertMailServerHost } from "./host-guard";
import { readInstallState } from "./settings";
import { appendRecentError, type ExternalAccountRow } from "./serialize-utils";
import { externalSyncRefusal } from "./sync-target";
import {
	baselineLastUid,
	CHECK_NOW_COOLDOWN_MS,
	classifySyncError,
	externalRawKey,
	externalSyncMessage,
	isSyncStateChange,
	nextRegularSync,
	planInboxSync,
	RESET_LOOKBACK_MS,
	resetLastUid,
	selectNewMessages,
	sourceFlags,
	SYNC_FETCH_CHUNK,
	SYNC_LEASE_MS,
	SYNC_MAX_MESSAGE_BYTES,
	SYNC_PLAN_LIMIT,
	SYNC_RUN_BUDGET_MS,
	syncFailureUpdate,
	type InboxState,
	type SyncProblem,
} from "./sync-utils";

const logger = createLogger("external-sync");

const INBOX = "INBOX";
/** Queue messages per `sendBatch` (the Workers limit is 100). */
const SEND_BATCH = 100;

/** The states a check runs in; `error` keeps retrying every 6 hours, or after Check now. */
const SYNCING_STATUSES = ["active", "error"] as const;

/** The conditions under which an account is checked at all: checking on, a password saved, not suspended. */
const syncable = () =>
	and(
		eq(externalAccounts.syncEnabled, true),
		ne(externalAccounts.secret, ""),
		isNull(externalAccounts.suspendedAt),
		inArray(externalAccounts.status, [...SYNCING_STATUSES]),
	);

const leaseFree = (now: Date) => or(isNull(externalAccounts.leaseUntil), lt(externalAccounts.leaseUntil, now));

/**
 * The 5-minute cron (and the Node scheduler): claims up to 200 accounts whose check is due, oldest first, pushing their
 * `next_sync_at` past the lease in the same statement, and queues one `accounts.sync` run for each. Nothing runs while
 * the install switch is off or before migration 0079; a refused owner's accounts are suspended and so never due.
 */
export async function planExternalSync(env: CloudflareEnv, now = new Date()): Promise<number> {
	if (!env.AGENT_QUEUE || !(await externalAccountTablesReady(env))) return 0;
	if (!(await readInstallState(env)).enabled) return 0;
	const db = getDb(env);
	const due = db
		.select({ id: externalAccounts.id })
		.from(externalAccounts)
		.where(
			and(
				syncable(),
				leaseFree(now),
				or(
					and(
						eq(externalAccounts.status, "active"),
						or(isNull(externalAccounts.nextSyncAt), lte(externalAccounts.nextSyncAt, now)),
					),
					and(eq(externalAccounts.status, "error"), lte(externalAccounts.nextSyncAt, now)),
				),
			),
		)
		.orderBy(asc(externalAccounts.nextSyncAt))
		.limit(SYNC_PLAN_LIMIT);
	const claimed = await db
		.update(externalAccounts)
		.set({ nextSyncAt: new Date(now.getTime() + SYNC_LEASE_MS) })
		.where(inArray(externalAccounts.id, due))
		.returning({ id: externalAccounts.id });
	for (let index = 0; index < claimed.length; index += SEND_BATCH)
		await env.AGENT_QUEUE.sendBatch(
			claimed.slice(index, index + SEND_BATCH).map((account) => ({ body: externalSyncMessage(account.id) })),
		);
	return claimed.length;
}

export type SyncRunOptions = {
	now?: () => Date;
	/** For the jitter of the backoff; tests pin it. */
	random?: () => number;
	budgetMs?: number;
};

export type SyncRunResult =
	| { skipped: "migration_pending" | "removed" | "not_syncing" | "not_allowed" | "busy" }
	| { delivered: number; skipped: number; more: boolean }
	| { failed: SyncProblem["class"] };

/** A refusal Kite meets before the server answers anything: the class it gets is `config`, never a retry. */
class SyncRefusedError extends Error {
	constructor(
		message: string,
		readonly problem: SyncProblem["class"] = "config",
	) {
		super(message);
		this.name = "SyncRefusedError";
	}
}

/**
 * One sync run of one account (spec §6.3): checks again that the account may be used, takes its lease, signs in,
 * examines INBOX and hands every new message to the inbound pipeline through the Mail store and `INBOUND_QUEUE`.
 * Never throws for the account's own problems; they become its state (§6.5).
 */
export async function syncExternalAccount(
	env: CloudflareEnv,
	accountId: string,
	options: SyncRunOptions = {},
): Promise<SyncRunResult> {
	const clock = options.now ?? (() => new Date());
	if (!(await externalAccountTablesReady(env))) return { skipped: "migration_pending" };
	const db = getDb(env);
	const [account] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, accountId)).limit(1);
	if (!account) return { skipped: "removed" };
	const now = clock();
	const lease = new Date(now.getTime() + SYNC_LEASE_MS);
	const [claimed] = await db
		.update(externalAccounts)
		.set({ leaseUntil: lease, lastSyncAt: now })
		.where(and(eq(externalAccounts.id, accountId), syncable(), leaseFree(now)))
		.returning({ id: externalAccounts.id });
	if (!claimed)
		return account.leaseUntil && account.leaseUntil > now ? { skipped: "busy" } : { skipped: "not_syncing" };
	const refusal = await externalSyncRefusal(env, account);
	if (refusal && refusal !== "mailbox_access") {
		await releaseLease(env, accountId, lease);
		return { skipped: "not_allowed" };
	}
	const started = Date.now();
	try {
		if (refusal)
			throw new SyncRefusedError(
				"Kite can no longer deliver into this account's mailbox. Edit the account to choose another one.",
			);
		const outcome = await runSync(env, account, { budgetMs: options.budgetMs ?? SYNC_RUN_BUDGET_MS, clock });
		await recordSuccess(env, account, lease, outcome, clock());
		logger.info("external.sync.checked", {
			accountId,
			delivered: outcome.delivered,
			skipped: outcome.skipped,
			more: outcome.more,
			reset: outcome.reset,
			durationMs: Date.now() - started,
		});
		recordMetric(env.METRICS, {
			event: "external_sync",
			service: "kite",
			name: outcome.delivered ? "new_mail" : "checked",
			outcome: "ok",
			durationMs: Date.now() - started,
			attempts: outcome.delivered,
		});
		return { delivered: outcome.delivered, skipped: outcome.skipped, more: outcome.more };
	} catch (error) {
		const problem = classify(error, account);
		await recordFailure(env, account, lease, problem, clock(), options.random ?? Math.random);
		logger.warn("external.sync.failed", {
			accountId,
			class: problem.class,
			failures: account.consecutiveFailures + 1,
			durationMs: Date.now() - started,
		});
		recordMetric(env.METRICS, {
			event: "external_sync",
			service: "kite",
			name: problem.class,
			outcome: "error",
			durationMs: Date.now() - started,
		});
		return { failed: problem.class };
	}
}

function classify(error: unknown, account: ExternalAccountRow): SyncProblem {
	if (error instanceof SyncRefusedError) return { class: error.problem, message: error.message };
	return classifySyncError(error, {
		refused: error instanceof MailServerRefusedError,
		host: account.imapHost,
	});
}

type RunOutcome = { delivered: number; skipped: number; more: boolean; reset: boolean; notes: string[] };

/** Signs in with the saved password, opened only for this run. */
async function openSession(env: CloudflareEnv, account: ExternalAccountRow): Promise<ImapSession> {
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
		return await openImapSession(env, {
			host: account.imapHost,
			port: account.imapPort,
			security: account.imapSecurity,
			username: account.username,
			password,
		});
	} catch (error) {
		// A server that echoes the password back must not get it into the account's error text.
		if (error instanceof Error && password && error.message.includes(password))
			error.message = error.message.split(password).join("•••");
		throw error;
	}
}

async function runSync(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	options: { budgetMs: number; clock: () => Date },
): Promise<RunOutcome> {
	const session = await openSession(env, account);
	try {
		const state = await session.examine(INBOX);
		const db = getDb(env);
		const [cursor] = await db
			.select()
			.from(externalAccountFolders)
			.where(and(eq(externalAccountFolders.accountId, account.id), eq(externalAccountFolders.name, INBOX)))
			.limit(1);
		const plan = planInboxSync(cursor ? { uidValidity: cursor.uidvalidity, lastUid: cursor.lastUid } : null, state);
		const outcome: RunOutcome = { delivered: 0, skipped: 0, more: false, reset: false, notes: [] };
		if (plan.kind === "baseline") {
			const uids = state.uidNext === null ? (await session.searchUids()).map(Number) : [];
			await saveCursor(env, account.id, state, baselineLastUid(state.uidNext, uids), options.clock());
			return outcome;
		}
		if (plan.kind === "unchanged") {
			await saveCursor(env, account.id, state, cursor!.lastUid!, options.clock());
			return outcome;
		}
		let lastUid = plan.kind === "fetch" ? plan.fromUid - 1 : 0;
		if (plan.kind === "reset") {
			const since = new Date((account.lastSuccessAt ?? options.clock()).getTime() - RESET_LOOKBACK_MS);
			lastUid = resetLastUid(await session.searchUidsSince(since), state.uidNext);
			await saveCursor(env, account.id, state, lastUid, options.clock());
			outcome.reset = true;
			outcome.notes.push("The provider reset the Inbox; Kite checked the last two days again.");
		}
		const { take, more } = selectNewMessages(await session.fetchSummaries(lastUid + 1), lastUid);
		outcome.more = more;
		const started = Date.now();
		for (let index = 0; index < take.length; index += SYNC_FETCH_CHUNK) {
			if (Date.now() - started > options.budgetMs) {
				outcome.more = true;
				break;
			}
			const chunk = take.slice(index, index + SYNC_FETCH_CHUNK);
			await deliverChunk(env, session, account, state, chunk, outcome);
			lastUid = chunk[chunk.length - 1].uid;
			await saveCursor(env, account.id, state, lastUid, options.clock());
		}
		return outcome;
	} finally {
		await session.close().catch(() => undefined);
	}
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Fetches one chunk's bodies and hands each to the inbound pipeline: the raw message at its deterministic key in the
 * Mail store, then one `INBOUND_QUEUE` message with the source flags. A message above the size Kite receives is
 * skipped and named in the account's problems; one expunged meanwhile is simply gone.
 */
async function deliverChunk(
	env: CloudflareEnv,
	session: ImapSession,
	account: ExternalAccountRow,
	state: InboxState,
	chunk: ImapMessageSummary[],
	outcome: RunOutcome,
): Promise<void> {
	const tooLarge = (entry: ImapMessageSummary) => entry.size !== null && entry.size > SYNC_MAX_MESSAGE_BYTES;
	const wanted = chunk.filter((entry) => !tooLarge(entry)).map((entry) => String(entry.uid));
	const bodies = wanted.length ? await session.fetchMessages(wanted) : new Map();
	for (const entry of chunk) {
		if (tooLarge(entry)) {
			outcome.skipped += 1;
			const received = entry.internalDate ? ` received ${entry.internalDate.toISOString().slice(0, 10)}` : "";
			outcome.notes.push(
				`Skipped a ${megabytes(entry.size!)} message${received}: Kite receives messages up to ${megabytes(SYNC_MAX_MESSAGE_BYTES)}.`,
			);
			continue;
		}
		const message = bodies.get(String(entry.uid));
		if (!message) continue;
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
}

/** The envelope sender the provider recorded (`Return-Path`, written at its final delivery), or empty. */
function envelopeSender(raw: ArrayBuffer): string {
	return getEmailAddress(parseRawHeaders(raw).get("return-path")?.[0] ?? "") || "";
}

async function saveCursor(env: CloudflareEnv, accountId: string, state: InboxState, lastUid: number, now: Date) {
	const values = { uidvalidity: state.uidValidity, uidnext: state.uidNext, lastUid, lastCheckedAt: now };
	await getDb(env)
		.insert(externalAccountFolders)
		.values({ accountId, name: INBOX, role: "inbox", ...values })
		.onConflictDoUpdate({ target: [externalAccountFolders.accountId, externalAccountFolders.name], set: values });
}

async function releaseLease(env: CloudflareEnv, accountId: string, lease: Date): Promise<void> {
	await getDb(env)
		.update(externalAccounts)
		.set({ leaseUntil: null })
		.where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.leaseUntil, lease)));
}

const stillOurs = (accountId: string, lease: Date) =>
	and(eq(externalAccounts.id, accountId), eq(externalAccounts.leaseUntil, lease));

/**
 * A check that worked: failures reset, the next check due after the interval, or at once (a run queued now) when
 * more mail is waiting. An account whose owner was refused meanwhile keeps the state that refusal gave it.
 */
async function recordSuccess(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	lease: Date,
	outcome: RunOutcome,
	now: Date,
): Promise<void> {
	const db = getDb(env);
	let recentErrors = account.recentErrors;
	for (const note of outcome.notes) recentErrors = appendRecentError(recentErrors, note, now);
	const [saved] = await db
		.update(externalAccounts)
		.set({
			consecutiveFailures: 0,
			lastError: null,
			lastSuccessAt: now,
			recentErrors,
			nextSyncAt: outcome.more
				? new Date(now.getTime() + SYNC_LEASE_MS)
				: nextRegularSync(now, account.syncIntervalMinutes),
			leaseUntil: null,
			updatedAt: now,
		})
		.where(stillOurs(account.id, lease))
		.returning({ status: externalAccounts.status });
	if (!saved) return;
	await db
		.update(externalAccounts)
		.set({ status: "active", statusReason: null })
		.where(and(eq(externalAccounts.id, account.id), inArray(externalAccounts.status, [...SYNCING_STATUSES])));
	if (outcome.more) await env.AGENT_QUEUE?.send(externalSyncMessage(account.id));
	if (account.consecutiveFailures > 0 || account.status === "error")
		await auditExternalAccount(env, {
			actorUserId: null,
			targetUserId: account.userId,
			action: "external_account.sync_recovered",
			mailboxId: account.mailboxId,
			metadata: { accountId: account.id, failures: account.consecutiveFailures },
		});
}

/**
 * A check that failed (spec §6.5): the class decides the new state, and the backoff when Kite retries. A state change
 * writes an audit row, and a sign-in that stopped working tells the owner once, in the open tabs.
 */
async function recordFailure(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	lease: Date,
	problem: SyncProblem,
	now: Date,
	random: () => number,
): Promise<void> {
	const db = getDb(env);
	const update = syncFailureUpdate(account, problem, now, random());
	const common = {
		lastError: update.lastError,
		consecutiveFailures: update.consecutiveFailures,
		nextSyncAt: update.nextSyncAt,
		recentErrors: appendRecentError(account.recentErrors, update.lastError, now),
		leaseUntil: null,
		updatedAt: now,
	};
	// The status changes only while the account is still checked; one paused meanwhile keeps its pause.
	const [changed] = await db
		.update(externalAccounts)
		.set({ ...common, status: update.status, statusReason: update.statusReason })
		.where(and(stillOurs(account.id, lease), inArray(externalAccounts.status, [...SYNCING_STATUSES])))
		.returning({ id: externalAccounts.id });
	if (!changed) {
		await db.update(externalAccounts).set(common).where(stillOurs(account.id, lease));
		return;
	}
	if (isSyncStateChange(account, update))
		await auditExternalAccount(env, {
			actorUserId: null,
			targetUserId: account.userId,
			action: "external_account.sync_failed",
			mailboxId: account.mailboxId,
			metadata: { accountId: account.id, class: problem.class, status: update.status },
		});
	if (update.status === "auth_failed" && account.status !== "auth_failed")
		await notifyUsersOfNewMessage(env, [account.userId], {
			type: "module_notice",
			moduleId: "connected_accounts",
			notice: "sign_in_failed",
			title: `Kite cannot sign in to ${account.address}`,
			body: "Reconnect it to keep its new mail arriving.",
			href: "/settings/connected-accounts",
		}).catch(() => undefined);
}

/**
 * **Check now**: queues a run for one account at once, at most once a minute and never beside a running one. The
 * caller has checked that the account is the user's own and that they may use connected accounts.
 */
export async function queueSyncNow(
	env: CloudflareEnv,
	account: ExternalAccountRow,
	now = new Date(),
): Promise<"queued" | "too_soon" | "unavailable"> {
	if (!env.AGENT_QUEUE) return "unavailable";
	const recent = new Date(now.getTime() - CHECK_NOW_COOLDOWN_MS);
	const [claimed] = await getDb(env)
		.update(externalAccounts)
		.set({ lastSyncAt: now, nextSyncAt: new Date(now.getTime() + SYNC_LEASE_MS) })
		.where(
			and(
				eq(externalAccounts.id, account.id),
				syncable(),
				leaseFree(now),
				or(isNull(externalAccounts.lastSyncAt), lt(externalAccounts.lastSyncAt, recent)),
			),
		)
		.returning({ id: externalAccounts.id });
	if (!claimed) return "too_soon";
	await env.AGENT_QUEUE.send(externalSyncMessage(account.id));
	return "queued";
}
