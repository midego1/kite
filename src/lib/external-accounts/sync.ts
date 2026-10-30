import { and, asc, count, eq, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import type { ImapLimits } from "@/lib/imap/types";
import { createLogger } from "@/lib/logger.mjs";
import { recordMetric } from "@/lib/metrics.mjs";
import { MailServerRefusedError } from "@/lib/net/errors";
import { notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import { auditExternalAccount } from "./audit";
import { externalAccountTablesReady } from "./errors";
import { appendRecentErrors } from "./recent-errors";
import { readInstallState } from "./settings";
import type { ExternalAccountRow } from "./serialize-utils";
import { emptyOutcome, runSync, SyncRefusedError, type RunOutcome } from "./sync-run";
import { externalSyncRefusal } from "./sync-target";
import {
	CHECK_NOW_COOLDOWN_MS,
	classifySyncError,
	externalSyncMessage,
	isSyncStateChange,
	nextRegularSync,
	SYNC_LEASE_MS,
	SYNC_PLAN_LIMIT,
	SYNC_RUN_BUDGET_MS,
	syncFailureUpdate,
	type SyncProblem,
} from "./sync-utils";

const logger = createLogger("external-sync");

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
	const isDue = and(
		syncable(),
		leaseFree(now),
		// A disabled Kite account's connected accounts are never claimed (a run would only refuse them).
		inArray(externalAccounts.userId, db.select({ id: users.id }).from(users).where(eq(users.disabled, false))),
		or(
			and(
				eq(externalAccounts.status, "active"),
				or(isNull(externalAccounts.nextSyncAt), lte(externalAccounts.nextSyncAt, now)),
			),
			and(eq(externalAccounts.status, "error"), lte(externalAccounts.nextSyncAt, now)),
		),
	);
	const due = db
		.select({ id: externalAccounts.id })
		.from(externalAccounts)
		.where(isDue)
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
	// More due than one tick takes: they wait for the next ticks, oldest first. Said once per tick, so it shows.
	if (claimed.length === SYNC_PLAN_LIMIT) {
		const [left] = await db.select({ due: count() }).from(externalAccounts).where(isDue);
		if (left?.due) logger.warn("external.sync.backlog", { claimed: claimed.length, stillDue: left.due });
	}
	return claimed.length;
}

export type SyncRunOptions = {
	now?: () => Date;
	/** For the jitter of the backoff; tests pin it. */
	random?: () => number;
	budgetMs?: number;
	/** Tests only: smaller connection limits. */
	limits?: Partial<ImapLimits>;
};

export type SyncRunResult =
	| { skipped: "migration_pending" | "removed" | "not_syncing" | "not_allowed" | "busy" }
	| { delivered: number; skipped: number; more: boolean }
	| { failed: SyncProblem["class"] };

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
	// A lease nobody gave back means the last run was stopped by the platform (out of time or memory) mid-way.
	const unfinished = !!account.leaseUntil && account.leaseUntil <= now;
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
	const outcome = emptyOutcome();
	try {
		if (refusal)
			throw new SyncRefusedError(
				"Kite can no longer deliver into this account's mailbox. Edit the account to choose another one.",
			);
		// Counted as a failure, so runs the platform keeps stopping back off and show on the account.
		if (unfinished)
			throw new SyncRefusedError(
				"The last check did not finish: it ran out of time or was stopped. Kite tries again later.",
				"transient",
			);
		await runSync(
			env,
			account,
			{ budgetMs: options.budgetMs ?? SYNC_RUN_BUDGET_MS, clock, lease, limits: options.limits },
			outcome,
		);
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
		await recordFailure(env, account, lease, problem, clock(), options.random ?? Math.random, outcome.notes);
		logger.warn("external.sync.failed", {
			accountId,
			class: problem.class,
			// The error's name only: its message may carry server text.
			error: error instanceof Error ? error.name : "unknown",
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
	const [saved] = await db
		.update(externalAccounts)
		.set({
			consecutiveFailures: 0,
			lastError: null,
			lastSuccessAt: now,
			...(outcome.notes.length ? { recentErrors: appendRecentErrors(outcome.notes, now) } : {}),
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
	/** What the run noted before it failed (skipped messages), kept with the failure. */
	notes: readonly string[] = [],
): Promise<void> {
	const db = getDb(env);
	const update = syncFailureUpdate(account, problem, now, random());
	const common = {
		lastError: update.lastError,
		consecutiveFailures: update.consecutiveFailures,
		nextSyncAt: update.nextSyncAt,
		recentErrors: appendRecentErrors([...notes, update.lastError], now),
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
