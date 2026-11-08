import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { externalAccountAuthRechecks, externalAccounts, messageExternalAccounts } from "@/db/schema/external-accounts";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { completeRawHeaderFields } from "@/lib/email/raw-headers";
import { ExternalAccountRefusal, externalAccountTablesReady } from "./errors";
import { findPreset } from "./presets-utils";
import {
	AUTH_RECHECK_LEASE_MS,
	AUTH_RECHECK_PAGE_SIZE,
	AUTH_RECHECK_SINCE_DAYS,
	authRecheckAuthservId,
	authRecheckMessage,
	authRecheckView,
	hasAuthenticationSignal,
	isAuthRecheckMessage,
	parseStoredSignals,
	recheckSignals,
	type AuthRecheckView,
} from "./auth-recheck-utils";
import type { AccountActor } from "./service";

const log = createLogger("external-sync");

type AuthRecheckRow = typeof externalAccountAuthRechecks.$inferSelect;

const AUTH_RECHECK_TABLE = "external_account_auth_rechecks";

/** Whether migration 0100 is applied; reads only `sqlite_master`, and only once it is needed. */
async function authRecheckTableReady(env: CloudflareEnv): Promise<boolean> {
	const { results } = await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.bind(AUTH_RECHECK_TABLE)
		.all();
	return results.length > 0;
}

async function ownEligibleAccount(env: CloudflareEnv, actor: AccountActor, id: string) {
	if (!(await externalAccountTablesReady(env))) throw new ExternalAccountRefusal(409, "Account not found");
	const [row] = await getDb(env)
		.select()
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, id), eq(externalAccounts.userId, actor.id)))
		.limit(1);
	if (!row) throw new ExternalAccountRefusal(404, "Account not found");
	const authservId = authRecheckAuthservId(row, findPreset(row.preset)?.authservId ?? null);
	if (!authservId)
		throw new ExternalAccountRefusal(
			409,
			"Recheck authentication is only for connected Gmail and Google Workspace accounts",
			"NOT_ELIGIBLE",
		);
	return { row, authservId };
}

/** Every one of these accounts' recheck rows, by account id, for the Connected accounts list. */
export async function readAuthRechecks(
	env: CloudflareEnv,
	accountIds: readonly string[],
): Promise<Map<string, AuthRecheckView>> {
	const map = new Map<string, AuthRecheckView>();
	if (accountIds.length === 0 || !(await authRecheckTableReady(env))) return map;
	const rows = await getDb(env)
		.select()
		.from(externalAccountAuthRechecks)
		.where(inArray(externalAccountAuthRechecks.accountId, accountIds));
	for (const row of rows) map.set(row.accountId, authRecheckView(row));
	return map;
}

async function enqueue(env: CloudflareEnv, accountId: string): Promise<void> {
	await env.AGENT_QUEUE?.send(authRecheckMessage(accountId));
}

/**
 * Starts (or resumes) "Recheck authentication" for one of the signed-in user's accounts (spec §6.6.1): the last
 * `AUTH_RECHECK_SINCE_DAYS` days of that account's own mail, read again from its raw MIME for Google's own
 * authentication header. A finished run starts over from the same window; a running one is left alone, queued again
 * only when nothing holds its lease.
 */
export async function startAuthRecheck(env: CloudflareEnv, actor: AccountActor, id: string, now = new Date()) {
	const { row: account } = await ownEligibleAccount(env, actor, id);
	if (!(await authRecheckTableReady(env))) throw new ExternalAccountRefusal(409, "Account not found");
	const existing = (
		await getDb(env)
			.select()
			.from(externalAccountAuthRechecks)
			.where(eq(externalAccountAuthRechecks.accountId, account.id))
			.limit(1)
	)[0];
	if (existing?.status === "running") {
		if (!existing.leaseUntil || existing.leaseUntil < now) await enqueue(env, account.id);
		return authRecheckView(existing);
	}
	const since = new Date(now.getTime() - AUTH_RECHECK_SINCE_DAYS * 86_400_000);
	const values = {
		status: "running" as const,
		sinceAt: since,
		cursorAt: null,
		cursorId: null,
		scanned: 0,
		updated: 0,
		skipped: 0,
		error: null,
		leaseUntil: null,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
	};
	await getDb(env)
		.insert(externalAccountAuthRechecks)
		.values({ accountId: account.id, ...values })
		.onConflictDoUpdate({ target: externalAccountAuthRechecks.accountId, set: values });
	await enqueue(env, account.id);
	const [row] = await getDb(env)
		.select()
		.from(externalAccountAuthRechecks)
		.where(eq(externalAccountAuthRechecks.accountId, account.id))
		.limit(1);
	return authRecheckView(row ?? null);
}

async function lease(env: CloudflareEnv, accountId: string, now: Date): Promise<AuthRecheckRow | null> {
	const [row] = await getDb(env)
		.update(externalAccountAuthRechecks)
		.set({ leaseUntil: new Date(now.getTime() + AUTH_RECHECK_LEASE_MS), updatedAt: now })
		.where(
			and(
				eq(externalAccountAuthRechecks.accountId, accountId),
				eq(externalAccountAuthRechecks.status, "running"),
				or(isNull(externalAccountAuthRechecks.leaseUntil), lt(externalAccountAuthRechecks.leaseUntil, now)),
			),
		)
		.returning();
	return row ?? null;
}

type Cursor = { createdAt: Date; id: string } | null;

type Candidate = {
	id: string;
	createdAt: Date;
	fromAddr: string;
	rawR2Key: string | null;
	spamSignals: string | null;
};

async function candidatePage(env: CloudflareEnv, accountId: string, since: Date, after: Cursor): Promise<Candidate[]> {
	return getDb(env)
		.select({
			id: messages.id,
			createdAt: messages.createdAt,
			fromAddr: messages.fromAddr,
			rawR2Key: messages.rawR2Key,
			spamSignals: messages.spamSignals,
		})
		.from(messages)
		.where(
			and(
				sql`${messageExternalAccounts}.${sql.identifier("external_account_id")} = ${accountId}`,
				eq(messages.direction, "inbound"),
				gte(messages.createdAt, since),
				after
					? or(
							gt(messages.createdAt, after.createdAt),
							and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id)),
						)
					: undefined,
			),
		)
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(AUTH_RECHECK_PAGE_SIZE);
}

/** One message: true when its stored signals gained an authentication result, false otherwise (never an error). */
async function recheckOne(env: CloudflareEnv, message: Candidate, authservId: string): Promise<boolean> {
	if (hasAuthenticationSignal(parseStoredSignals(message.spamSignals))) return false;
	if (!message.rawR2Key) return false;
	const object = await env.BUCKET.get(message.rawR2Key);
	if (!object) return false;
	const raw = await object.arrayBuffer();
	const fields = completeRawHeaderFields(raw);
	const outcome = recheckSignals(message.spamSignals, fields, authservId, message.fromAddr);
	if (outcome.kind === "unchanged") return false;
	await getDb(env)
		.update(messages)
		.set({ spamSignals: JSON.stringify(outcome.signals) })
		.where(eq(messages.id, message.id));
	return true;
}

type Progress = { scanned: number; updated: number; skipped: number; cursor: Cursor; done: boolean };

async function runPage(env: CloudflareEnv, row: AuthRecheckRow, authservId: string): Promise<Progress> {
	const after: Cursor = row.cursorAt && row.cursorId ? { createdAt: row.cursorAt, id: row.cursorId } : null;
	const page = await candidatePage(env, row.accountId, row.sinceAt, after);
	let updated = 0;
	let skipped = 0;
	let cursor = after;
	for (const message of page) {
		cursor = { createdAt: message.createdAt, id: message.id };
		try {
			if (await recheckOne(env, message, authservId)) updated += 1;
		} catch (error) {
			skipped += 1;
			log.warn("external.auth_recheck_message_failed", { messageId: message.id, error });
		}
	}
	return { scanned: page.length, updated, skipped, cursor, done: page.length < AUTH_RECHECK_PAGE_SIZE };
}

async function saveProgress(env: CloudflareEnv, row: AuthRecheckRow, progress: Progress, now: Date): Promise<void> {
	await getDb(env)
		.update(externalAccountAuthRechecks)
		.set({
			cursorAt: progress.cursor?.createdAt ?? row.cursorAt,
			cursorId: progress.cursor?.id ?? row.cursorId,
			scanned: row.scanned + progress.scanned,
			updated: row.updated + progress.updated,
			skipped: row.skipped + progress.skipped,
			leaseUntil: null,
			updatedAt: now,
			...(progress.done ? { status: "done" as const, finishedAt: now } : {}),
		})
		.where(eq(externalAccountAuthRechecks.accountId, row.accountId));
}

/**
 * The `accounts.auth_recheck` queue message: one leased run, which hands on to the next run until the cursor reaches
 * today. Deterministic only: no model, no network call but the Mail store itself.
 */
async function runAuthRecheck(env: CloudflareEnv, accountId: string): Promise<void> {
	if (!(await authRecheckTableReady(env)) || !(await externalAccountTablesReady(env))) return;
	const now = new Date();
	const row = await lease(env, accountId, now);
	if (!row) return;
	const [account] = await getDb(env).select().from(externalAccounts).where(eq(externalAccounts.id, accountId)).limit(1);
	const authservId = account ? authRecheckAuthservId(account, findPreset(account.preset)?.authservId ?? null) : null;
	if (!authservId) {
		await getDb(env)
			.update(externalAccountAuthRechecks)
			.set({ status: "failed", error: "The account is no longer eligible", leaseUntil: null, updatedAt: now })
			.where(eq(externalAccountAuthRechecks.accountId, accountId));
		return;
	}
	let progress: Progress;
	try {
		progress = await runPage(env, row, authservId);
	} catch (error) {
		await getDb(env)
			.update(externalAccountAuthRechecks)
			.set({ leaseUntil: null, updatedAt: new Date() })
			.where(eq(externalAccountAuthRechecks.accountId, accountId));
		log.warn("external.auth_recheck_failed", { accountId, error });
		throw error;
	}
	await saveProgress(env, row, progress, new Date());
	if (!progress.done) await enqueue(env, accountId);
}

/** Routes an `accounts.auth_recheck` queue message; true when this was one. */
export async function processAuthRecheckMessage(env: CloudflareEnv, body: unknown): Promise<boolean> {
	if (!isAuthRecheckMessage(body)) return false;
	await runAuthRecheck(env, body.accountId);
	return true;
}

/**
 * The five-minute safety net: a running recheck whose run died (no lease, or one that ran out) is queued again, as
 * the payment scan's own safety net does.
 */
export async function resumeAuthRechecks(env: CloudflareEnv, now = new Date()): Promise<number> {
	if (!(await authRecheckTableReady(env))) return 0;
	let stalled: { accountId: string }[];
	try {
		stalled = await getDb(env)
			.select({ accountId: externalAccountAuthRechecks.accountId })
			.from(externalAccountAuthRechecks)
			.where(
				and(
					eq(externalAccountAuthRechecks.status, "running"),
					or(isNull(externalAccountAuthRechecks.leaseUntil), lt(externalAccountAuthRechecks.leaseUntil, now)),
					lt(externalAccountAuthRechecks.updatedAt, new Date(now.getTime() - 60_000)),
				),
			)
			.orderBy(asc(externalAccountAuthRechecks.updatedAt))
			.limit(20);
	} catch (error) {
		if (isNoSuchTableError(error)) return 0;
		throw error;
	}
	for (const { accountId } of stalled) await enqueue(env, accountId);
	return stalled.length;
}
