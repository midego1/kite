import { normalizeMessageId } from "@/lib/email/thread-lookup";
import { findJunkFolder, findMarkedFolder, findTrashFolder, type SyncFolderRole } from "./sync-utils";
import type { KiteChange, ProviderMoveKind, ProviderSupport, TwoWaySettings } from "./two-way-types";

/**
 * Two-way sync's decisions (spec §6.8), pure: which settings are valid, what a server supports, what a user's action
 * becomes in the outbox, what a write-back does, and what a provider-to-Kite pass concludes. The I/O is in
 * `two-way-store.ts` and `two-way-run.ts`.
 */

/** Newest tracked INBOX messages one pass compares: `UID FETCH … (UID FLAGS)` of these is about 300 KB. */
export const RECONCILE_WINDOW = 5_000;
/** Changes one pass makes in Kite; the rest wait for the next check. */
const RECONCILE_MAX_CHANGES = 500;
/** Older messages linked from their raw keys per check. */
export const BACKFILL_PAGE = 1_000;
/** Outbox rows one run takes. */
export const WRITEBACK_ROWS_PER_RUN = 200;
/** Messages per IMAP command of a write-back. */
export const WRITEBACK_BATCH = 50;
/** Tries before a change is given up on. */
const WRITEBACK_MAX_ATTEMPTS = 6;
/** How long an action waits before any run takes it: an Undo wins, and a burst goes out together. */
export const WRITEBACK_DELAY_SECONDS = 60;
/** How long the queued run waits: just past the delay, so what it came for is due when it arrives. */
export const WRITEBACK_KICK_DELAY_SECONDS = WRITEBACK_DELAY_SECONDS + 5;
/** At most one queued write-back per account in this time. */
export const WRITEBACK_KICK_MS = 60_000;
/** From this many tracked messages on, an Inbox holding under half of them is not believed. */
const FAR_BELOW_MIN_TRACKED = 10;
/** How long a server's answers are trusted before the settings ask it again. */
export const SUPPORT_MAX_AGE_MS = 24 * 60 * 60_000;

/** @public Exercised by the unit tests. */
export const TWO_WAY_OFF: TwoWaySettings = {
	kiteDelete: "nothing",
	kiteArchive: "nothing",
	kiteSpam: "nothing",
	kiteFlags: false,
	providerGone: "nothing",
	providerFlags: false,
};

/** The stored settings; anything missing or damaged reads as off. */
export function readTwoWaySettings(stored: string | null | undefined): TwoWaySettings {
	let value: unknown = null;
	try {
		value = JSON.parse(stored ?? "{}");
	} catch {
		return TWO_WAY_OFF;
	}
	const parsed = parseTwoWayInput({ ...TWO_WAY_OFF, ...(value as object) });
	return parsed ?? TWO_WAY_OFF;
}

/** Settings from a request, or null when one of them is not a valid choice. Every field is required. */
export function parseTwoWayInput(body: unknown): TwoWaySettings | null {
	const input = (body ?? {}) as Record<keyof TwoWaySettings, unknown>;
	const { kiteDelete, kiteArchive, kiteSpam, kiteFlags, providerGone, providerFlags } = input;
	if (kiteDelete !== "nothing" && kiteDelete !== "trash") return null;
	if (kiteArchive !== "nothing" && kiteArchive !== "archive") return null;
	if (kiteSpam !== "nothing" && kiteSpam !== "spam") return null;
	if (providerGone !== "nothing" && providerGone !== "trash") return null;
	if (typeof kiteFlags !== "boolean" || typeof providerFlags !== "boolean") return null;
	return { kiteDelete, kiteArchive, kiteSpam, kiteFlags, providerGone, providerFlags };
}

export const writesToProvider = (settings: TwoWaySettings) =>
	settings.kiteDelete === "trash" ||
	settings.kiteArchive === "archive" ||
	settings.kiteSpam === "spam" ||
	settings.kiteFlags;

export const readsFromProvider = (settings: TwoWaySettings) =>
	settings.providerGone === "trash" || settings.providerFlags;

/** Whether the setting for this kind of action is on. */
export function actionAllowed(settings: TwoWaySettings, kind: ProviderMoveKind | "flags"): boolean {
	if (kind === "trash") return settings.kiteDelete === "trash";
	if (kind === "archive") return settings.kiteArchive === "archive";
	if (kind === "spam") return settings.kiteSpam === "spam";
	return settings.kiteFlags;
}

type ListedFolder = { name: string; delimiter: string | null; attributes: readonly string[] };

/**
 * What a server can do, from what it announces. Gmail lists All Mail as `\All`, not `\Archive`, and moving there is how
 * a message leaves the Inbox and stays in All Mail. A server with neither `MOVE` nor `UIDPLUS` could only expunge the
 * whole folder, which would take what another client marked deleted too, so it gets no move at all.
 */
export function planProviderSupport(
	capabilities: readonly string[],
	listed: readonly ListedFolder[],
	now: Date,
): ProviderSupport {
	const gmail = capabilities.includes("X-GM-EXT-1");
	return {
		moveMethod: capabilities.includes("MOVE") ? "move" : capabilities.includes("UIDPLUS") ? "copy" : null,
		trashFolder: findTrashFolder(listed),
		junkFolder: findJunkFolder(listed),
		archiveFolder: findMarkedFolder(listed, gmail ? "\\All" : "\\Archive"),
		gmail,
		checkedAt: now.toISOString(),
	};
}

/** The folder a move goes to, or null when this server has no such move. */
export function moveTarget(support: ProviderSupport | null, kind: ProviderMoveKind): string | null {
	if (!support?.moveMethod) return null;
	if (kind === "trash") return support.trashFolder;
	if (kind === "spam") return support.junkFolder;
	return support.archiveFolder;
}

/** Why these settings cannot be saved for this server, or null. */
export function twoWaySupportProblem(settings: TwoWaySettings, support: ProviderSupport | null): string | null {
	for (const kind of ["trash", "archive", "spam"] as const) {
		if (!actionAllowed(settings, kind) || moveTarget(support, kind)) continue;
		if (!support) return "Kite could not ask this account's server what it supports. Try again in a moment.";
		const names = { trash: "a Trash folder", archive: "an Archive folder", spam: "a Spam folder" };
		return support.moveMethod
			? `This account has no ${names[kind].replace(/^an? /, "")} Kite can move mail to.`
			: "This account's server cannot move a message safely, so Kite does not offer it.";
	}
	return null;
}

/** Whether the stored Message-ID and the one at the provider name the same message; a missing one proves nothing. */
export function sameMessageId(stored: string | null | undefined, atProvider: string | null | undefined): boolean {
	const id = normalizeMessageId(stored);
	return id !== null && id === normalizeMessageId(atProvider);
}

/** A message a user acted on, as the outbox needs it. */
export type ChangeTarget = {
	messageId: string;
	accountId: string;
	mailboxId: string | null;
	settings: TwoWaySettings;
	/** The message's mailbox is still the account's: the account owner's settings speak only for that mail. */
	inAccountMailbox: boolean;
	rfcMessageId: string | null;
	/** Where it sits at the provider; null when Kite does not know, or the message has left. */
	place: { role: SyncFolderRole; uidvalidity: number; uid: number } | null;
};

/** What a user's move to this status is for two-way sync. */
export function kiteMove(status: string): KiteChange {
	if (status === "trash") return { kind: "trash" };
	if (status === "archived") return { kind: "archive" };
	return { kind: status === "spam" ? "spam" : "other" };
}

export type OutboxPlan = {
	/** Rows to write, replacing what waits under the same id. */
	writes: {
		id: string;
		accountId: string;
		messageId: string;
		kind: ProviderMoveKind | "flags";
		read: boolean | null;
		starred: boolean | null;
		role: SyncFolderRole;
		uidvalidity: number;
		uid: number;
		rfcMessageId: string | null;
	}[];
	/** Waiting moves this action makes pointless: an Undo, or a later move the setting does not carry to the provider. */
	cancels: string[];
};

/** @public Exercised by the unit tests. */
export const moveActionId = (messageId: string) => `${messageId}:move`;
export const flagsActionId = (messageId: string) => `${messageId}:flags`;

/**
 * The outbox rows of one user action. The settings are read at this moment, so an action only reaches the provider
 * when the setting was on when it happened, and only mail still in the account's mailbox counts.
 */
export function planOutbox(targets: readonly ChangeTarget[], change: KiteChange): OutboxPlan {
	const plan: OutboxPlan = { writes: [], cancels: [] };
	for (const target of targets) {
		const { messageId, accountId, settings, place, rfcMessageId } = target;
		const usable = target.inAccountMailbox && place;
		if (change.kind === "flags") {
			if (!usable || !settings.kiteFlags) continue;
			plan.writes.push({
				id: flagsActionId(messageId),
				accountId,
				messageId,
				kind: "flags",
				read: change.read ?? null,
				starred: change.starred ?? null,
				rfcMessageId,
				...place,
			});
		} else if (
			change.kind !== "other" &&
			usable &&
			actionAllowed(settings, change.kind) &&
			(!change.junkOnly || place.role === "junk")
		) {
			plan.writes.push({
				id: moveActionId(messageId),
				accountId,
				messageId,
				kind: change.kind,
				read: null,
				starred: null,
				rfcMessageId,
				...place,
			});
		} else plan.cancels.push(moveActionId(messageId));
	}
	return plan;
}

/** An outbox row with the last state Kite knows at the provider. */
export type OutboxRow = OutboxPlan["writes"][number] & {
	createdAt: Date;
	attempts: number;
	step: number;
	providerRead: boolean | null;
	providerStarred: boolean | null;
};

/** What a message is at the provider right now. */
export type ProviderFact = { messageId: string | null; read: boolean; starred: boolean };

/** One `UID STORE`: the rows whose flag it changes. */
export type StoreGroup = { change: "+" | "-"; flag: "\\Seen" | "\\Flagged"; rows: OutboxRow[] };

export type WritebackPlan = {
	/** Gone from the folder: nothing left to do. */
	missing: OutboxRow[];
	/** The UID now holds another message: never touched. */
	mismatched: OutboxRow[];
	stores: StoreGroup[];
	/** Flag rows with what the provider will hold once their stores went through. */
	flags: { row: OutboxRow; read: boolean | null; starred: boolean | null }[];
	moves: { kind: ProviderMoveKind; rows: OutboxRow[] }[];
};

/**
 * @public Exercised by the unit tests. Whether a provider change beats a Kite action still waiting (last writer wins by time): the provider differs from
 * what Kite last saw, and the action is from before the last pass, so the provider's change is provably the newer one.
 * An action after the last pass wins: the provider's change has no time of its own and cannot be proven later.
 */
export function providerIsNewer(
	action: { createdAt: Date },
	current: boolean,
	lastSeen: boolean | null,
	lastPassAt: Date | null,
): boolean {
	if (lastSeen === null || current === lastSeen || !lastPassAt) return false;
	return action.createdAt.getTime() <= lastPassAt.getTime();
}

/** What one flag of a flag row does: store it, leave it, or give way to a newer change at the provider. */
function planFlag(
	row: OutboxRow,
	wanted: boolean | null,
	current: boolean,
	lastSeen: boolean | null,
	context: { providerFlags: boolean; lastPassAt: Date | null },
): { store: boolean; after: boolean | null } {
	if (wanted === null) return { store: false, after: lastSeen };
	if (context.providerFlags && providerIsNewer(row, current, lastSeen, context.lastPassAt))
		return { store: false, after: lastSeen };
	return { store: wanted !== current, after: wanted };
}

/** What one batch of outbox rows does, given what `UID FETCH` found at their UIDs. Flags come before the moves. */
export function planWriteback(
	rows: readonly OutboxRow[],
	facts: ReadonlyMap<number, ProviderFact>,
	context: { providerFlags: boolean; lastPassAt: Date | null },
): WritebackPlan {
	const plan: WritebackPlan = { missing: [], mismatched: [], stores: [], flags: [], moves: [] };
	const group = (change: StoreGroup["change"], flag: StoreGroup["flag"], row: OutboxRow) => {
		const found = plan.stores.find((entry) => entry.change === change && entry.flag === flag);
		if (found) found.rows.push(row);
		else plan.stores.push({ change, flag, rows: [row] });
	};
	for (const row of rows) {
		const fact = facts.get(row.uid);
		if (!fact) plan.missing.push(row);
		else if (!sameMessageId(row.rfcMessageId, fact.messageId)) plan.mismatched.push(row);
		else if (row.kind === "flags") {
			const read = planFlag(row, row.read, fact.read, row.providerRead, context);
			const starred = planFlag(row, row.starred, fact.starred, row.providerStarred, context);
			if (read.store) group(row.read ? "+" : "-", "\\Seen", row);
			if (starred.store) group(row.starred ? "+" : "-", "\\Flagged", row);
			plan.flags.push({ row, read: read.after, starred: starred.after });
		} else {
			const found = plan.moves.find((entry) => entry.kind === row.kind);
			if (found) found.rows.push(row);
			else plan.moves.push({ kind: row.kind, rows: [row] });
		}
	}
	return plan;
}

/** When a failed change is tried again: 5 minutes after the first failure, then ×3, at most 6 hours. */
export function writebackRetryMs(attempts: number): number {
	return Math.min(5 * 60_000 * 3 ** Math.max(attempts - 1, 0), 6 * 60 * 60_000);
}

export const isLastAttempt = (attempts: number) => attempts + 1 >= WRITEBACK_MAX_ATTEMPTS;

/** A tracked INBOX message as a pass compares it. */
export type WindowRef = {
	messageId: string;
	uid: number;
	providerRead: boolean | null;
	providerStarred: boolean | null;
	/** An earlier session found this UID absent. */
	missing: boolean;
};

/** A flag change seen at the provider: the changed fields, and everything the provider holds now. */
export type FlagChange = {
	messageId: string;
	uid: number;
	read?: boolean;
	starred?: boolean;
	provider: { read: boolean; starred: boolean };
};

export type ReconcileInput = {
	refs: readonly WindowRef[];
	/** What `UID FETCH … (UID FLAGS)` found, by UID. */
	seen: ReadonlyMap<number, { read: boolean; starred: boolean }>;
	/** Whether that answer may be read as "what is not here has left" (`judgeAnswer`). */
	believed: boolean;
	syncGone: boolean;
	syncFlags: boolean;
	/** The setting was just turned on: this pass only records what it finds. */
	adoptGone: boolean;
	adoptFlags: boolean;
	/** Messages with a move waiting: they are leaving because of Kite, or Kite will move them itself. */
	pendingMoves: ReadonlySet<string>;
	maxChanges?: number;
};

export type ReconcilePlan = {
	/** Rows whose last-seen state becomes what the provider holds, with no change in Kite. */
	baselines: { messageId: string; read: boolean; starred: boolean }[];
	flagChanges: FlagChange[];
	/** Absent for the first time: noted, and looked up by UID in the next session. */
	newlyMissing: string[];
	/** Absent again, in a later session: looked up by UID now, and gone only if that finds nothing. */
	candidates: { messageId: string; uid: number }[];
	/** Noted as absent earlier, and here after all. */
	found: string[];
	/** Not there, and nothing to do about it: left before anyone asked, or was never compared. */
	silentlyGone: string[];
	/** The pass stopped at its limit, so the next one must run whatever the server says. */
	truncated: boolean;
};

/**
 * Why a folder's answer cannot be read as "what is not here has left", or null when it can. An empty Inbox, or one
 * holding far fewer messages than Kite tracks, is more often a provider's hiccup than a user's work, and either way the
 * cost of waiting is small. The answer's own count is checked against EXISTS: the messages before the first one answered
 * (its sequence number says how many), those answered, and those after the range (at most the UIDs above it) must add
 * up to what the folder holds, so a capped or cut answer shows.
 */
export function judgeAnswer(input: {
	exists: number | null;
	uidNext: number | null;
	tracked: number;
	high: number;
	answered: readonly { seq: number }[];
}): "empty_folder" | "far_below" | "partial" | null {
	const { exists, uidNext, tracked, high, answered } = input;
	if (!tracked) return null;
	if (exists === null) return "partial";
	if (exists === 0) return "empty_folder";
	if (tracked >= FAR_BELOW_MIN_TRACKED && exists * 2 < tracked) return "far_below";
	if (!answered.length) return "partial";
	const before = Math.min(...answered.map((entry) => entry.seq)) - 1;
	const after = Math.max((uidNext ?? 0) - 1 - high, 0);
	return before + answered.length + after < exists ? "partial" : null;
}

/** What a pass concludes per message, before the second look at what is missing. */
function planRef(ref: WindowRef, input: ReconcileInput, plan: ReconcilePlan) {
	const found = input.seen.get(ref.uid);
	if (!found) {
		if (input.pendingMoves.has(ref.messageId) || !input.believed) return;
		const counts = input.syncGone && !input.adoptGone && ref.providerRead !== null;
		if (!counts) plan.silentlyGone.push(ref.messageId);
		else if (ref.missing) plan.candidates.push({ messageId: ref.messageId, uid: ref.uid });
		else plan.newlyMissing.push(ref.messageId);
		return;
	}
	if (ref.missing) plan.found.push(ref.messageId);
	if (ref.providerRead === null || ref.providerStarred === null || input.adoptFlags) {
		plan.baselines.push({ messageId: ref.messageId, ...found });
		return;
	}
	if (!input.syncFlags) return;
	const read = found.read !== ref.providerRead ? { read: found.read } : {};
	const starred = found.starred !== ref.providerStarred ? { starred: found.starred } : {};
	if ("read" in read || "starred" in starred)
		plan.flagChanges.push({ messageId: ref.messageId, uid: ref.uid, ...read, ...starred, provider: found });
}

/**
 * What one provider-to-Kite pass concludes. A message absent from a believed answer is noted; only an absence seen by
 * an earlier session as well becomes a candidate, and a candidate is gone only once `UID FETCH` of its own UID finds
 * nothing either. A row never compared with the server, or a pass that only takes a baseline, changes nothing in Kite.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const plan: ReconcilePlan = {
		baselines: [],
		flagChanges: [],
		newlyMissing: [],
		candidates: [],
		found: [],
		silentlyGone: [],
		truncated: false,
	};
	for (const ref of input.refs) planRef(ref, input, plan);
	const max = input.maxChanges ?? RECONCILE_MAX_CHANGES;
	plan.truncated = plan.candidates.length + plan.flagChanges.length > max;
	plan.candidates = plan.candidates.slice(0, max);
	plan.flagChanges = plan.flagChanges.slice(0, Math.max(max - plan.candidates.length, 0));
	return plan;
}

/** A Kite flag action still waiting, by message. */
export type PendingFlags = { createdAt: Date; read: boolean | null; starred: boolean | null };

/**
 * Splits a provider flag change by last writer: `kite` has what Kite takes, `dropped` the fields of a waiting Kite
 * action the provider beat. A field with a newer Kite action stays as Kite has it; that action overwrites the provider
 * at the next write-back.
 */
export function resolveFlagChange(
	change: FlagChange,
	pending: PendingFlags | undefined,
	lastPassAt: Date | null,
): { kite: { read?: boolean; starred?: boolean }; dropped: ("read" | "starred")[] } {
	const kite: { read?: boolean; starred?: boolean } = {};
	const dropped: ("read" | "starred")[] = [];
	for (const field of ["read", "starred"] as const) {
		const value = change[field];
		if (value === undefined) continue;
		const waiting = pending?.[field] ?? null;
		if (waiting === null) {
			kite[field] = value;
			continue;
		}
		// Kite's action came after the last pass: it stands, and the write-back overwrites the provider.
		if (!lastPassAt || pending!.createdAt.getTime() > lastPassAt.getTime()) continue;
		kite[field] = value;
		dropped.push(field);
	}
	return { kite, dropped };
}

/** The working state a pass reads; missing on an account that never ran one. */
type PassState = {
	uidvalidity: number | null;
	lowUid: number;
	lastPassAt: Date | null;
	goneBaseline: boolean;
	flagsBaseline: boolean;
};

/** What a pass starts from: the window's floor (back to 0 in a rebuilt folder), and what it only records this time. */
export function planPass(settings: TwoWaySettings, state: PassState | null, uidValidity: number) {
	const syncGone = settings.providerGone === "trash";
	return {
		syncGone,
		syncFlags: settings.providerFlags,
		adoptGone: syncGone && (state?.goneBaseline ?? true),
		adoptFlags: settings.providerFlags && (state?.flagsBaseline ?? true),
		lowUid: state?.uidvalidity === uidValidity ? state.lowUid : 0,
		lastPassAt: state?.lastPassAt ?? null,
	};
}

/**
 * What a finished pass leaves for the next one. A pass with anything left to look at must run again whatever the server
 * says, so its modseq is not kept. A baseline still owed stays owed when the answer could not be believed.
 */
export function passResult(
	pass: ReturnType<typeof planPass>,
	state: PassState | null,
	inbox: { uidValidity: number; highestModseq: string | null; exists: number | null; uidNext: number | null },
	outcome: { plan: ReconcilePlan; distrust: string | null; lowUid: number; backfilled: boolean },
) {
	const { plan, distrust, lowUid, backfilled } = outcome;
	const unsettled = plan.truncated || distrust || !backfilled || plan.newlyMissing.length || plan.candidates.length;
	return {
		uidvalidity: inbox.uidValidity,
		highestModseq: unsettled ? null : inbox.highestModseq,
		existsCount: inbox.exists,
		uidNext: inbox.uidNext,
		lowUid,
		goneBaseline: (state?.goneBaseline ?? true) && (!pass.adoptGone || !!distrust),
		flagsBaseline: (state?.flagsBaseline ?? true) && (!pass.adoptFlags || !!distrust),
		gonePaused: !!distrust,
	};
}

/** The state the last pass left, as far as skipping the next one goes. */
export type PassMarks = {
	uidvalidity: number | null;
	highestModseq: string | null;
	existsCount: number | null;
	uidNext: number | null;
};

/**
 * Whether a pass can be skipped: the server has CONDSTORE and nothing moved. `HIGHESTMODSEQ` alone is not enough, since
 * a CONDSTORE server without QRESYNC need not raise it for an expunge; EXISTS and UIDNEXT together catch that.
 */
export function nothingChanged(
	last: PassMarks,
	now: { uidValidity: number | null; highestModseq: string | null; exists: number | null; uidNext: number | null },
): boolean {
	return (
		now.highestModseq !== null &&
		last.highestModseq === now.highestModseq &&
		last.uidvalidity === now.uidValidity &&
		last.existsCount === now.exists &&
		last.uidNext === now.uidNext
	);
}
