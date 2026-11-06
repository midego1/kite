import { chunkArray } from "@/db/chunk-utils";
import { parseRawHeaders } from "@/lib/email/raw-headers";
import type { ImapSession } from "@/lib/imap/session";
import { getMailboxNotificationUserIds, notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import { shortServerText } from "./connection-utils";
import { auditExternalAccount } from "./audit";
import type { ExternalAccountRow } from "./serialize-utils";
import { externalWritebackMessage, sourceFlags } from "./sync-utils";
import {
	deleteActions,
	failActions,
	finishFlags,
	finishMoved,
	readDueActions,
	readPendingActions,
	saveStep,
} from "./two-way-outbox";
import {
	applyReconcile,
	junkFolderName,
	linkFetchedMessages,
	readRfcMessageIds,
	readSupport,
	readTwoWayConfig,
	readWindow,
	saveSupport,
	twoWayReady,
	updateTwoWayState,
	type KiteFlagUpdate,
	type TwoWayConfig,
} from "./two-way-store";
import type { ProviderSupport } from "./two-way-types";
import {
	actionAllowed,
	isLastAttempt,
	judgeAnswer,
	moveTarget,
	nothingChanged,
	passResult,
	planPass,
	planProviderSupport,
	planReconcile,
	planWriteback,
	readsFromProvider,
	RECONCILE_WINDOW,
	resolveFlagChange,
	sameMessageId,
	WRITEBACK_BATCH,
	WRITEBACK_KICK_DELAY_SECONDS,
	WRITEBACK_ROWS_PER_RUN,
	writesToProvider,
	type FlagChange,
	type OutboxRow,
	type ProviderFact,
	type ReconcilePlan,
	type StoreGroup,
} from "./two-way-utils";

/** What a pass needs from the run around it. */
export type TwoWayRun = { clock: () => Date; outOfTime: () => boolean; notes: string[] };

type Failures = Map<string, { row: OutboxRow; reason: string }>;

const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

const KIND_TEXT: Record<OutboxRow["kind"], string> = {
	trash: "move to the provider's Trash",
	archive: "archive at the provider",
	spam: "move to the provider's Spam folder",
	flags: "mark at the provider",
};

/** A tagged NO or BAD to a write: the server's answer about these messages, not a broken connection. */
const isRefusal = (error: unknown) =>
	error instanceof Error && /^IMAP (?:MOVE|COPY|STORE|EXPUNGE) failed:/.test(error.message);

/** What `UID FETCH` finds at these UIDs: flags and Message-ID. A UID that is gone is simply not in the answer. */
async function readFacts(session: ImapSession, uids: readonly number[]): Promise<Map<number, ProviderFact>> {
	const fetched = await session.fetchMessages(uids.map(String), { messageIdHeader: true });
	const facts = new Map<number, ProviderFact>();
	for (const [uid, message] of fetched) {
		const flags = sourceFlags(message.flags);
		const messageId = parseRawHeaders(message.raw).get("message-id")?.[0] ?? null;
		facts.set(Number(uid), { messageId, ...flags });
	}
	return facts;
}

/**
 * `readFacts` that survives a message the server will not read (Gmail answers NO for the whole command): the rest are
 * read one by one, and the UIDs it refused are returned apart, because "refused" is not "gone".
 */
async function readFactsApart(session: ImapSession, uids: readonly number[]) {
	const refused = new Set<number>();
	const read = async (some: readonly number[]): Promise<Map<number, ProviderFact>> => {
		try {
			return await readFacts(session, some);
		} catch (error) {
			if (!(error instanceof Error) || !/^IMAP fetch failed:/.test(error.message)) throw error;
			if (some.length === 1) {
				refused.add(some[0]);
				return new Map();
			}
			// One at a time: a connection runs one command, and an IMAP answer has no way to say whose it is.
			const facts = new Map<number, ProviderFact>();
			for (const uid of some) for (const [key, fact] of await read([uid])) facts.set(key, fact);
			return facts;
		}
	};
	return { facts: await read(uids), refused };
}

/** Runs `write` on all rows, then message by message after a refusal, so one bad message cannot hold back the rest. */
async function eachSucceeding(
	rows: readonly OutboxRow[],
	write: (uids: number[]) => Promise<void>,
	failures: Failures,
): Promise<OutboxRow[]> {
	if (!rows.length) return [];
	try {
		await write(rows.map((row) => row.uid));
		return [...rows];
	} catch (error) {
		if (!isRefusal(error)) throw error;
		if (rows.length > 1) {
			const done: OutboxRow[] = [];
			for (const row of rows) done.push(...(await eachSucceeding([row], write, failures)));
			return done;
		}
		failures.set(rows[0].id, { row: rows[0], reason: shortServerText((error as Error).message) });
		return [];
	}
}

/**
 * The fallback RFC 6851 names where the server has no MOVE: copy, mark deleted, then remove exactly those UIDs. Each
 * step is recorded as it lands, so a retry does only what is left and never copies twice, and nothing leaves the
 * folder unless its copy answered OK. No other expunge exists in this code.
 */
async function moveByCopy(
	env: CloudflareEnv,
	session: ImapSession,
	rows: readonly OutboxRow[],
	folder: string,
	failures: Failures,
): Promise<OutboxRow[]> {
	const copied = await eachSucceeding(
		rows.filter((row) => row.step < 1),
		(uids) => session.copyMessages(uids, folder),
		failures,
	);
	await saveStep(env, copied, 1);
	const marked = await eachSucceeding(
		rows.filter((row) => row.step === 1),
		(uids) => session.storeFlags(uids, "+", ["\\Deleted"]),
		failures,
	);
	await saveStep(env, marked, 2);
	return eachSucceeding(
		rows.filter((row) => row.step === 2),
		(uids) => session.expungeMessages(uids),
		failures,
	);
}

/** Giving up on a move that got as far as the mark: the message stays, and must not stay marked for another client. */
async function clearAbandonedMarks(session: ImapSession, rows: readonly OutboxRow[], failures: Failures) {
	const abandoned = rows.filter((row) => row.step >= 2 && failures.has(row.id) && isLastAttempt(row.attempts));
	if (!abandoned.length) return;
	await session
		.storeFlags(
			abandoned.map((row) => row.uid),
			"-",
			["\\Deleted"],
		)
		.catch((error: unknown) => {
			if (!isRefusal(error)) throw error;
		});
}

/** Moves one kind of row to its folder, and returns the rows that left. */
async function moveRows(
	env: CloudflareEnv,
	session: ImapSession,
	support: ProviderSupport,
	rows: readonly OutboxRow[],
	target: string,
	failures: Failures,
) {
	if (support.moveMethod !== "move") return moveByCopy(env, session, rows, target, failures);
	return eachSucceeding(rows, (uids) => session.moveMessages(uids, target), failures);
}

/** One batch of one folder: read what is at the UIDs, then flags, then moves, recording each result as it lands. */
async function writeBatch(
	env: CloudflareEnv,
	session: ImapSession,
	rows: readonly OutboxRow[],
	context: {
		config: TwoWayConfig;
		support: ProviderSupport | null;
		sourceFolder: string;
		failures: Failures;
		counts: { moved: number; flagged: number; refused: number; unsupported: number };
	},
): Promise<void> {
	const { config, support, sourceFolder, failures, counts } = context;
	const { facts, refused } = await readFactsApart(
		session,
		rows.map((row) => row.uid),
	);
	for (const row of rows)
		if (refused.has(row.uid)) failures.set(row.id, { row, reason: "The server would not show the message" });
	const readable = rows.filter((row) => !refused.has(row.uid));
	const plan = planWriteback(readable, facts, {
		providerFlags: config.settings.providerFlags,
		lastPassAt: config.state?.lastPassAt ?? null,
	});
	counts.refused += plan.mismatched.length;
	await finishMoved(env, [...plan.missing.filter((row) => row.kind !== "flags"), ...plan.mismatched]);
	// A flag change for a message that left: only the change is over. The message leaving is the pass's to find.
	await deleteActions(
		env,
		plan.missing.filter((row) => row.kind === "flags").map((row) => row.id),
	);
	const stored = new Set<string>();
	const storeFailed = async ({ change, flag, rows: group }: StoreGroup) => {
		for (const row of await eachSucceeding(group, (uids) => session.storeFlags(uids, change, [flag]), failures))
			stored.add(row.id);
	};
	for (const group of plan.stores) await storeFailed(group);
	const flagged = plan.flags.filter(({ row }) => !failures.has(row.id));
	await finishFlags(env, flagged);
	counts.flagged += stored.size;
	for (const { kind, rows: group } of plan.moves) {
		const target = moveTarget(support, kind);
		if (!support || !target) {
			counts.unsupported += group.length;
			await deleteActions(
				env,
				group.map((row) => row.id),
			);
			continue;
		}
		const done = target === sourceFolder ? group : await moveRows(env, session, support, group, target, failures);
		await finishMoved(env, done);
		counts.moved += done.length;
	}
	await clearAbandonedMarks(session, readable, failures);
}

/** Flags go first in the folder, because a move gives its message another UID. */
const flagsFirst = (rows: readonly OutboxRow[]) =>
	[...rows].sort((a, b) => Number(a.kind !== "flags") - Number(b.kind !== "flags"));

function noteOutcome(
	run: TwoWayRun,
	stale: number,
	counts: { refused: number; unsupported: number },
	failures: Failures,
	gaveUp: number,
) {
	if (stale)
		run.notes.push(`The provider rebuilt a folder, so Kite dropped ${plural(stale, "change")} waiting for it.`);
	if (counts.refused)
		run.notes.push(`Kite left ${plural(counts.refused, "message")} alone at the provider: it no longer matched.`);
	if (counts.unsupported)
		run.notes.push(`Kite dropped ${plural(counts.unsupported, "change")}: the provider no longer has that folder.`);
	const [first] = failures.values();
	if (first) {
		const count = plural(failures.size, "message");
		run.notes.push(`Kite could not ${KIND_TEXT[first.row.kind]} ${count}; it tries again later: ${first.reason}`);
	}
	if (gaveUp) run.notes.push(`Kite gave up on ${plural(gaveUp, "change")} at the provider after several tries.`);
}

/**
 * Does what waits in the outbox of one account (spec §6.8): a read-write session, batches per folder, nothing outside
 * those UIDs. A row whose UIDVALIDITY is not the folder's any more is dropped unread; a setting turned off meanwhile
 * drops its rows. True when more is waiting.
 */
export async function drainOutbox(
	env: CloudflareEnv,
	session: ImapSession,
	account: Pick<ExternalAccountRow, "id" | "userId" | "mailboxId">,
	config: TwoWayConfig,
	run: TwoWayRun,
): Promise<boolean> {
	const now = run.clock();
	const due = await readDueActions(env, account.id, now, WRITEBACK_ROWS_PER_RUN + 1);
	const batch = due.slice(0, WRITEBACK_ROWS_PER_RUN);
	// A move half done finishes even with its setting off, or its copy and deleted mark would stay behind.
	const wanted = batch.filter((row) => row.step > 0 || actionAllowed(config.settings, row.kind));
	await deleteActions(
		env,
		batch.filter((row) => !wanted.includes(row)).map((row) => row.id),
	);
	if (!wanted.length) return false;
	let support: ProviderSupport | null = readSupport(config.state);
	if (wanted.some((row) => row.kind !== "flags")) {
		support = planProviderSupport(session.capabilities, await session.listMailboxes(), now);
		await saveSupport(env, account.id, support);
	}
	const failures: Failures = new Map();
	const counts = { moved: 0, flagged: 0, refused: 0, unsupported: 0 };
	const context = { config, support, sourceFolder: "", failures, counts };
	let stale = 0;
	for (const role of ["inbox", "junk"] as const) {
		const rows = wanted.filter((row) => row.role === role);
		const folder = role === "inbox" ? "INBOX" : ((await junkFolderName(env, account.id)) ?? support?.junkFolder);
		// A folder with no name left, or another UIDVALIDITY: these UIDs identify nothing any more.
		const uidValidity = rows.length && folder ? (await session.select(folder)).uidValidity : null;
		const current = rows.filter((row) => row.uidvalidity === uidValidity);
		stale += rows.length - current.length;
		await deleteActions(
			env,
			rows.filter((row) => !current.includes(row)).map((row) => row.id),
		);
		for (const chunk of chunkArray(flagsFirst(current), WRITEBACK_BATCH)) {
			if (run.outOfTime()) break;
			await writeBatch(env, session, chunk, { ...context, sourceFolder: folder! });
		}
	}
	const gaveUp = await failActions(
		env,
		[...failures.values()].map(({ row }) => row),
		now,
	);
	noteOutcome(run, stale, counts, failures, gaveUp);
	if (counts.moved || counts.flagged)
		await auditExternalAccount(env, {
			actorUserId: null,
			targetUserId: account.userId,
			action: "external_account.two_way_applied",
			mailboxId: account.mailboxId,
			metadata: { accountId: account.id, moved: counts.moved, flagged: counts.flagged },
		});
	return due.length > WRITEBACK_ROWS_PER_RUN || run.outOfTime();
}

/** What the provider answers for the tracked range: every line, and the flags by UID. */
async function readWindowFlags(session: ImapSession, refs: readonly { uid: number }[], empty: boolean) {
	const seen = new Map<number, { read: boolean; starred: boolean }>();
	// A server may refuse a FETCH in an empty folder, and there is nothing to ask then.
	if (empty || !refs.length) return { seen, answered: [] };
	const answered = await session.fetchFlags(refs[refs.length - 1].uid, refs[0].uid);
	for (const entry of answered) seen.set(entry.uid, sourceFlags(entry.flags));
	return { seen, answered };
}

/**
 * The second look at what a previous session found missing: each UID asked for by name, in small batches. Gone is what
 * this answer does not hold either; `found` is what it does.
 */
async function confirmGone(session: ImapSession, candidates: ReconcilePlan["candidates"]) {
	const gone: string[] = [];
	const found: string[] = [];
	for (const chunk of chunkArray(candidates, WRITEBACK_BATCH)) {
		const present = new Set(
			(await session.fetchFlagsOf(chunk.map((candidate) => candidate.uid))).map((entry) => entry.uid),
		);
		for (const { messageId, uid } of chunk) (present.has(uid) ? found : gone).push(messageId);
	}
	return { gone, found };
}

const DISTRUST_TEXT: Record<NonNullable<ReturnType<typeof judgeAnswer>>, string> = {
	empty_folder: "The provider shows an empty Inbox",
	far_below: "The provider shows far fewer Inbox messages than Kite tracks",
	partial: "The provider's answer about the Inbox looks incomplete",
};

/** Says once per episode that deletes from the provider are paused, not at every check. */
function notePause(run: TwoWayRun, distrust: ReturnType<typeof judgeAnswer>, alreadyPaused: boolean) {
	if (distrust && !alreadyPaused)
		run.notes.push(
			`${DISTRUST_TEXT[distrust]}, so Kite moves nothing to Trash until that clears. If you emptied it yourself, turn "Deleted or moved out of the Inbox" off and on to start over.`,
		);
}

/** The flag changes whose UID still holds the stored message; the rest are left alone and their rows retired. */
async function verifiedChanges(env: CloudflareEnv, session: ImapSession, changes: readonly FlagChange[]) {
	const stored = await readRfcMessageIds(
		env,
		changes.map((change) => change.messageId),
	);
	const good: FlagChange[] = [];
	const mismatched: string[] = [];
	for (const chunk of chunkArray(changes, WRITEBACK_BATCH)) {
		const { facts, refused } = await readFactsApart(
			session,
			chunk.map((change) => change.uid),
		);
		for (const change of chunk) {
			// A message the server will not read now stays as it is, and the next pass sees the change again.
			if (refused.has(change.uid)) continue;
			const fact = facts.get(change.uid);
			if (fact && sameMessageId(stored.get(change.messageId), fact.messageId)) good.push(change);
			else mismatched.push(change.messageId);
		}
	}
	return { good, mismatched };
}

/** Applies a pass's plan: what is really gone, flag changes settled by last writer, then everything in one batch. */
async function applyPlan(
	env: CloudflareEnv,
	session: ImapSession,
	account: Pick<ExternalAccountRow, "id" | "mailboxId">,
	plan: ReconcilePlan,
	context: {
		lastPassAt: Date | null;
		flags: Awaited<ReturnType<typeof readPendingActions>>["flags"];
		run: TwoWayRun;
		now: Date;
	},
) {
	const { gone, found } = await confirmGone(session, plan.candidates);
	const { good, mismatched } = await verifiedChanges(env, session, plan.flagChanges);
	if (mismatched.length)
		context.run.notes.push(
			`Kite left ${plural(mismatched.length, "message")} alone: at the provider it no longer matched.`,
		);
	const kite: KiteFlagUpdate[] = [];
	const dropped: { messageId: string; fields: ("read" | "starred")[] }[] = [];
	for (const change of good) {
		const outcome = resolveFlagChange(change, context.flags.get(change.messageId), context.lastPassAt);
		if (Object.keys(outcome.kite).length) kite.push({ messageId: change.messageId, ...outcome.kite });
		if (outcome.dropped.length) dropped.push({ messageId: change.messageId, fields: outcome.dropped });
	}
	await applyReconcile(env, {
		accountId: account.id,
		mailboxId: account.mailboxId,
		plan: { ...plan, found: [...plan.found, ...found], silentlyGone: [...plan.silentlyGone, ...mismatched] },
		gone,
		now: context.now,
		applied: good,
		kite,
		dropped,
	});
	return { flagged: kite.length, trashed: gone.length, changed: kite[0]?.messageId ?? gone[0] };
}

/** The open tabs refetch their lists, as after a row's summary arrived; a change here reaches them without new mail. */
async function tellOpenTabs(
	env: CloudflareEnv,
	account: Pick<ExternalAccountRow, "userId" | "mailboxId">,
	messageId: string,
) {
	await getMailboxNotificationUserIds(env, account.mailboxId, account.userId)
		.then((users) =>
			notifyUsersOfNewMessage(env, users, { type: "message_summary", mailboxId: account.mailboxId, messageId }),
		)
		.catch(() => undefined);
}

/** Runs one pass over the window and records where it stands. */
async function comparePass(
	env: CloudflareEnv,
	session: ImapSession,
	account: Pick<ExternalAccountRow, "id" | "userId" | "mailboxId">,
	{ settings, state }: TwoWayConfig,
	inbox: Awaited<ReturnType<ImapSession["examine"]>> & { uidValidity: number },
	context: { run: TwoWayRun; backfilled: boolean; now: Date },
) {
	const { run, backfilled, now } = context;
	const pass = planPass(settings, state, inbox.uidValidity);
	const refs = await readWindow(env, account.id, inbox.uidValidity, pass.lowUid);
	const pending = await readPendingActions(env, account.id);
	const { seen, answered } = await readWindowFlags(session, refs, inbox.exists === 0);
	const distrust = judgeAnswer({
		exists: inbox.exists,
		uidNext: inbox.uidNext,
		tracked: refs.length,
		high: refs[0]?.uid ?? 0,
		answered,
	});
	const plan = planReconcile({ ...pass, refs, seen, believed: !distrust, pendingMoves: pending.moves });
	const applied = await applyPlan(env, session, account, plan, {
		lastPassAt: pass.lastPassAt,
		flags: pending.flags,
		run,
		now,
	});
	notePause(run, distrust, !!state?.gonePaused);
	const lowUid = refs.length === RECONCILE_WINDOW ? refs[refs.length - 1].uid : pass.lowUid;
	await updateTwoWayState(env, account.id, {
		...passResult(pass, state, inbox, { plan, distrust, lowUid, backfilled }),
		lastPassAt: now,
		backfilled,
	});
	if (!applied.changed) return;
	await auditExternalAccount(env, {
		actorUserId: null,
		targetUserId: account.userId,
		action: "external_account.two_way_received",
		mailboxId: account.mailboxId,
		metadata: { accountId: account.id, flagged: applied.flagged, trashed: applied.trashed },
	});
	await tellOpenTabs(env, account, applied.changed);
}

/**
 * The provider-to-Kite pass of a regular check (spec §6.8), read-only at the provider: `EXAMINE INBOX`, then the flags
 * of the newest tracked messages. A UIDVALIDITY the rows do not carry leaves them out by itself, so a rebuilt folder
 * moves nothing. Skipped when CONDSTORE shows nothing moved since the last pass.
 */
async function reconcileInbox(
	env: CloudflareEnv,
	session: ImapSession,
	account: Pick<ExternalAccountRow, "id" | "userId" | "mailboxId">,
	config: TwoWayConfig,
	run: TwoWayRun,
): Promise<void> {
	const inbox = await session.examine("INBOX");
	const { uidValidity } = inbox;
	if (uidValidity === null) return;
	const now = run.clock();
	const { state } = config;
	const backfilled = state?.backfilled || (await linkFetchedMessages(env, account.id));
	if (state?.backfilled && !state.gonePaused && nothingChanged(state, inbox))
		return updateTwoWayState(env, account.id, { lastPassAt: now });
	await comparePass(env, session, account, config, { ...inbox, uidValidity }, { run, backfilled, now });
}

/**
 * Both directions of a regular check, after new mail. `session` is asked for only when the owner turned something on,
 * because the run's connection may first need replacing.
 */
export async function runTwoWay(
	env: CloudflareEnv,
	session: () => Promise<ImapSession>,
	account: Pick<ExternalAccountRow, "id" | "userId" | "mailboxId">,
	run: TwoWayRun,
): Promise<void> {
	if (!(await twoWayReady(env))) return;
	const config = await readTwoWayConfig(env, account.id);
	if (writesToProvider(config.settings)) {
		const more = await drainOutbox(env, await session(), account, config, run);
		// After this run gives the lease back.
		if (more)
			await env.AGENT_QUEUE?.send(externalWritebackMessage(account.id), { delaySeconds: WRITEBACK_KICK_DELAY_SECONDS });
	}
	if (readsFromProvider(config.settings) && !run.outOfTime())
		await reconcileInbox(env, await session(), account, config, run);
}
