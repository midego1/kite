import { redactedErrorMessage, shortServerText } from "./connection-utils";
import type { ExternalAccountStatus } from "./types";

/**
 * Sync bookkeeping (spec §6.3, §6.5), pure: what a run fetches, where it stores it, and what a failure does to the
 * account. `sync.ts` does the I/O.
 */

/** How often an account is checked, in minutes; 5 is the default and the shortest (decision 9). */
const SYNC_INTERVALS_MINUTES = [5, 15, 60] as const;
export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
/** Accounts one cron tick claims and queues. */
export const SYNC_PLAN_LIMIT = 200;
/** Messages one run fetches; the rest continue on a run queued right after it. */
const SYNC_MESSAGES_PER_RUN = 200;
/** Bodies per UID FETCH. */
export const SYNC_FETCH_CHUNK = 25;
/** A run stops starting new fetches after this long. */
export const SYNC_RUN_BUDGET_MS = 4 * 60_000;
/**
 * How long a run holds an account. A run stops fetching after four minutes, but one IMAP command may take up to ten
 * (`imapLimits`), and a queue invocation ends after fifteen; claiming pushes `next_sync_at` this far too, so a lost
 * queue message is retried by a later tick.
 */
export const SYNC_LEASE_MS = 15 * 60_000;
/** **Check now** works at most once a minute per account. */
export const CHECK_NOW_COOLDOWN_MS = 60_000;
/** @public Exercised by the unit tests. */
export const MAX_SYNC_BACKOFF_MS = 6 * 60 * 60_000;
/** After a day of failing to reach the server the account shows as `error`, and Kite keeps trying every 6 hours. */
const ERROR_AFTER_MS = 24 * 60 * 60_000;
/** Failures in a row before the owner is told the server cannot be reached. */
const NOTICE_AFTER_FAILURES = 3;
/** When the provider rebuilt INBOX (a new UIDVALIDITY), the last two days are checked again. */
export const RESET_LOOKBACK_MS = 2 * 24 * 60 * 60_000;
/** A message larger than Kite receives (the Email Routing limit) is skipped and named in the account's problems. */
export const SYNC_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** A valid interval from a request, or null. */
export function parseSyncInterval(value: unknown): number | null {
	const minutes = Number(value);
	return (SYNC_INTERVALS_MINUTES as readonly number[]).includes(minutes) ? minutes : null;
}

/** Where Kite stands in a folder: the UIDVALIDITY it knows and the last UID it fetched. */
export type InboxCursor = { uidValidity: number | null; lastUid: number | null };
/** What EXAMINE said now; `exists` is the message count (null when the server did not say). */
export type InboxState = { uidValidity: number | null; uidNext: number | null; exists?: number | null };

export type InboxPlan =
	/** No position yet (a database restored without one): start after what is there now. */
	| { kind: "baseline" }
	/** Same UIDVALIDITY, and UIDNEXT says nothing arrived: one EXAMINE was the whole check. */
	| { kind: "unchanged" }
	| { kind: "fetch"; fromUid: number }
	/** The provider rebuilt the folder: UIDs start again, so the last days are checked by date. */
	| { kind: "reset" };

export function planInboxSync(cursor: InboxCursor | null, state: InboxState): InboxPlan {
	if (!cursor || cursor.lastUid === null) return { kind: "baseline" };
	if (cursor.uidValidity !== null && state.uidValidity !== null && cursor.uidValidity !== state.uidValidity)
		return { kind: "reset" };
	if (state.uidNext !== null && state.uidNext <= cursor.lastUid + 1) return { kind: "unchanged" };
	return { kind: "fetch", fromUid: cursor.lastUid + 1 };
}

/** The last UID of a baseline: `UIDNEXT − 1`, or the highest UID there when the server named no UIDNEXT. */
export function baselineLastUid(uidNext: number | null, uids: readonly number[] = []): number {
	if (uidNext !== null) return Math.max(uidNext - 1, 0);
	return uids.reduce((highest, uid) => Math.max(highest, uid), 0);
}

/**
 * The cursor after a reset: just before the oldest message of the last two days, so the normal fetch takes them (and
 * dedupe drops what Kite has), or `UIDNEXT − 1` when there is none.
 */
export function resetLastUid(recentUids: readonly number[], uidNext: number | null): number {
	if (recentUids.length) return Math.max(Math.min(...recentUids) - 1, 0);
	return baselineLastUid(uidNext);
}

/**
 * The messages of a `UID FETCH n:*` answer a run takes, oldest first: only UIDs above `lastUid` (a server answers
 * `n:*` with its highest UID even when that is below `n`), at most `cap`; `more` says the rest wait for the next run.
 */
export function selectNewMessages<T extends { uid: number }>(
	summaries: readonly T[],
	lastUid: number,
	cap = SYNC_MESSAGES_PER_RUN,
): { take: T[]; more: boolean } {
	const seen = new Set<number>();
	const fresh = summaries
		.filter((entry) => entry.uid > lastUid && !seen.has(entry.uid) && !!seen.add(entry.uid))
		.sort((a, b) => a.uid - b.uid);
	return { take: fresh.slice(0, cap), more: fresh.length > cap };
}

/**
 * The UIDs a run asks about after `lastUid`: bounded by `UIDNEXT − 1` when the server named it, so a run never asks
 * for `n:*` (whose answer includes the highest UID even when it is below `n`), and null when there is nothing to ask:
 * an empty INBOX (some servers refuse `UID FETCH 1:*` there) or no UID above the cursor.
 */
export function fetchRange(state: InboxState, lastUid: number): { from: number; to: number | null } | null {
	if (state.exists === 0) return null;
	const from = lastUid + 1;
	if (state.uidNext === null) return { from, to: null };
	const to = state.uidNext - 1;
	return to >= from ? { from, to } : null;
}

/** One step of a run: fetch these messages in one UID FETCH, or skip one Kite cannot receive. */
export type FetchStep<T> = { kind: "fetch"; entries: T[] } | { kind: "skip"; entry: T };

/**
 * The fetches of a run, in UID order, so the cursor can move after each one (spec §6.3, review H1). A step holds at
 * most `maxCount` messages whose RFC822.SIZE adds up to `maxBytes` (the connection refuses a FETCH whose literals
 * exceed its batch limit); a message without a size, or alone above `maxBytes`, gets a step of its own; one above
 * `maxMessageBytes` (what Kite receives, and what one literal may be) is skipped.
 */
export function planFetchSteps<T extends { uid: number; size: number | null }>(
	entries: readonly T[],
	limits: { maxCount: number; maxBytes: number; maxMessageBytes: number },
): FetchStep<T>[] {
	const steps: FetchStep<T>[] = [];
	let batch: T[] = [];
	let bytes = 0;
	const flush = () => {
		if (batch.length) steps.push({ kind: "fetch", entries: batch });
		batch = [];
		bytes = 0;
	};
	for (const entry of entries) {
		if (entry.size !== null && entry.size > limits.maxMessageBytes) {
			flush();
			steps.push({ kind: "skip", entry });
			continue;
		}
		if (entry.size === null || entry.size > limits.maxBytes) {
			flush();
			steps.push({ kind: "fetch", entries: [entry] });
			continue;
		}
		if (batch.length >= limits.maxCount || bytes + entry.size > limits.maxBytes) flush();
		batch.push(entry);
		bytes += entry.size;
	}
	flush();
	return steps;
}

/** The Mail store key of a synced message: deterministic, so a retried run writes the same object. */
export function externalRawKey(accountId: string, uidValidity: number | null, uid: number): string {
	return `external/${accountId}/${uidValidity ?? 0}/${uid}.eml`;
}

/** Mail already read or starred at the provider arrives read or starred (flags are taken once, at fetch). */
export function sourceFlags(flags: readonly string[]): { read: boolean; starred: boolean } {
	const upper = flags.map((flag) => flag.toUpperCase());
	return { read: upper.includes("\\SEEN"), starred: upper.includes("\\FLAGGED") };
}

/** What kind of problem a sync run met (spec §6.5). */
type SyncErrorClass = "auth" | "tls" | "throttled" | "transient" | "config";

export type SyncProblem = { class: SyncErrorClass; message: string };

const THROTTLED = /\[(?:THROTTLED|LIMIT)\]|too many (?:simultaneous )?connections|rate.?limit|try again later/i;
const TRANSIENT =
	/\[UNAVAILABLE\]|\bBYE\b|did not answer in time|timed? ?out|closed unexpectedly|connection (?:reset|closed|refused|lost)|network|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|could not find the mail server/i;
const AUTH =
	/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|sign-in failed|invalid credentials|LOGIN failed|web ?login required|log ?in via your web browser|application-specific password|invalid_grant|saved password/i;
const TLS = /certificate|\bTLS\b|\bSSL\b|handshake|self[- ]signed|CERT_|ERR_TLS/i;

/**
 * Sorts a failed sync run. `refused` is Kite's own refusal before or while connecting (a server it must not reach, no
 * TLS offered, no password sign-in), which only an edit can change, except a name that does not resolve right now.
 * `secrets` are removed from the text; it is cut to 300 characters.
 */
export function classifySyncError(
	error: unknown,
	options: { refused?: boolean; secrets?: readonly string[]; host?: string } = {},
): SyncProblem {
	const raw = redactedErrorMessage(error, options.secrets);
	const message = shortServerText(raw);
	if (THROTTLED.test(raw)) return { class: "throttled", message };
	if (TRANSIENT.test(raw)) return { class: "transient", message };
	if (options.refused) return { class: "config", message };
	if (AUTH.test(raw)) return { class: "auth", message };
	if (TLS.test(raw))
		return {
			class: "tls",
			message: shortServerText(
				options.host ? `The server's certificate is not valid for ${options.host}. ${raw}` : raw,
			),
		};
	if (/NONEXISTENT|no such (?:folder|mailbox)|LOGINDISABLED|does not accept a password/i.test(raw))
		return { class: "config", message };
	return { class: "transient", message };
}

/**
 * @public Exercised by the unit tests. When to try again after `failures` failures in a row: `interval × 2^failures`, from 15 minutes when the provider
 * limits connections, at most 6 hours, with ±20% jitter (`random` in [0, 1)) so accounts do not retry in step.
 */
export function failureDelayMs(
	problem: SyncErrorClass,
	intervalMinutes: number,
	failures: number,
	random: number,
): number {
	const exponent = Math.min(Math.max(failures, 1), 16);
	const base = problem === "throttled" ? 15 * 60_000 * 2 ** (exponent - 1) : intervalMinutes * 60_000 * 2 ** exponent;
	const jittered = Math.min(base, MAX_SYNC_BACKOFF_MS) * (0.8 + 0.4 * Math.min(Math.max(random, 0), 1));
	return Math.round(Math.min(jittered, MAX_SYNC_BACKOFF_MS));
}

/** The account as a failure finds it. */
export type SyncAccountState = {
	status: ExternalAccountStatus;
	syncIntervalMinutes: number;
	consecutiveFailures: number;
	lastSuccessAt: Date | null;
	createdAt: Date;
};

export type SyncFailureUpdate = {
	status: ExternalAccountStatus;
	statusReason: string | null;
	lastError: string;
	consecutiveFailures: number;
	/** Null stops sync until the owner edits, reconnects or presses Check now. */
	nextSyncAt: Date | null;
};

/**
 * What a failure does to the account. Sign-in, certificate and configuration problems stop sync until the owner acts;
 * throttling and unreachable servers retry with backoff, and after a day of failures (and at least three in a row) the
 * account shows as `error` while Kite keeps trying every 6 hours.
 */
export function syncFailureUpdate(
	account: SyncAccountState,
	problem: SyncProblem,
	now: Date,
	random: number,
): SyncFailureUpdate {
	const consecutiveFailures = account.consecutiveFailures + 1;
	const stopped = { lastError: problem.message, consecutiveFailures, nextSyncAt: null };
	if (problem.class === "auth") return { ...stopped, status: "auth_failed", statusReason: "sync" };
	if (problem.class === "tls") return { ...stopped, status: "tls_failed", statusReason: "sync" };
	if (problem.class === "config") return { ...stopped, status: "error", statusReason: "config" };
	const failingFor = now.getTime() - (account.lastSuccessAt ?? account.createdAt).getTime();
	const longFailing = failingFor >= ERROR_AFTER_MS && consecutiveFailures >= NOTICE_AFTER_FAILURES;
	return {
		status: longFailing ? "error" : "active",
		statusReason: problem.class,
		lastError: problem.message,
		consecutiveFailures,
		nextSyncAt: new Date(
			now.getTime() +
				(longFailing
					? MAX_SYNC_BACKOFF_MS
					: failureDelayMs(problem.class, account.syncIntervalMinutes, consecutiveFailures, random)),
		),
	};
}

/** Whether a failure changes what the owner sees (and so writes an audit row): the first one, or a new status. */
export function isSyncStateChange(
	before: Pick<SyncAccountState, "status" | "consecutiveFailures">,
	after: SyncFailureUpdate,
) {
	return before.consecutiveFailures === 0 || before.status !== after.status;
}

/** When the next regular check is due after a successful run. */
export function nextRegularSync(now: Date, intervalMinutes: number): Date {
	return new Date(now.getTime() + Math.max(intervalMinutes, DEFAULT_SYNC_INTERVAL_MINUTES) * 60_000);
}

/** The queue message of one sync run, on `AGENT_QUEUE` next to imports (no new queue binding). */
export type ExternalSyncMessage = { kind: "accounts.sync"; accountId: string };

export function externalSyncMessage(accountId: string): ExternalSyncMessage {
	return { kind: "accounts.sync", accountId };
}

export function isExternalSyncMessage(body: unknown): body is ExternalSyncMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		(body as { kind?: unknown }).kind === "accounts.sync" &&
		typeof (body as { accountId?: unknown }).accountId === "string"
	);
}
