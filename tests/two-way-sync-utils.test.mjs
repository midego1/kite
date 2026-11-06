import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Two-way sync's decisions (spec §6.8): settings that default to off, what a server supports, what an action becomes in
// the outbox, the Message-ID check, last writer wins, baselines, and the hold on a mass disappearance.

const {
	actionAllowed,
	flagsActionId,
	judgeAnswer,
	kiteMove,
	moveActionId,
	moveTarget,
	nothingChanged,
	parseTwoWayInput,
	planOutbox,
	planProviderSupport,
	planReconcile,
	planWriteback,
	providerIsNewer,
	readTwoWaySettings,
	readsFromProvider,
	resolveFlagChange,
	sameMessageId,
	TWO_WAY_OFF,
	twoWaySupportProblem,
	writebackRetryMs,
	writesToProvider,
} = await bundleModules("kite-two-way-utils-", [
	[
		"actionAllowed, flagsActionId, judgeAnswer, kiteMove, moveActionId, moveTarget, nothingChanged, parseTwoWayInput, planOutbox, planProviderSupport, planReconcile, planWriteback, providerIsNewer, readTwoWaySettings, readsFromProvider, resolveFlagChange, sameMessageId, TWO_WAY_OFF, twoWaySupportProblem, writebackRetryMs, writesToProvider",
		"src/lib/external-accounts/two-way-utils.ts",
	],
]);

const NOW = new Date("2026-11-06T12:00:00Z");
const folder = (name, ...attributes) => ({ name, delimiter: "/", attributes });

test("settings default to off, and a damaged or partial value never turns anything on", () => {
	assert.deepEqual(readTwoWaySettings(null), TWO_WAY_OFF);
	assert.deepEqual(readTwoWaySettings("{}"), TWO_WAY_OFF);
	assert.deepEqual(readTwoWaySettings("not json"), TWO_WAY_OFF);
	assert.deepEqual(readTwoWaySettings('{"kiteDelete":"purge"}'), TWO_WAY_OFF);
	assert.equal(readTwoWaySettings('{"kiteDelete":"trash"}').kiteDelete, "trash");
	assert.equal(writesToProvider(TWO_WAY_OFF), false);
	assert.equal(readsFromProvider(TWO_WAY_OFF), false);
	assert.equal(writesToProvider({ ...TWO_WAY_OFF, kiteFlags: true }), true);
	assert.equal(readsFromProvider({ ...TWO_WAY_OFF, providerGone: "trash" }), true);
});

test("a request needs a valid choice for every setting; there is no permanent delete to choose", () => {
	assert.deepEqual(parseTwoWayInput(TWO_WAY_OFF), TWO_WAY_OFF);
	assert.equal(parseTwoWayInput({ ...TWO_WAY_OFF, kiteDelete: "delete" }), null);
	assert.equal(parseTwoWayInput({ ...TWO_WAY_OFF, providerGone: "delete" }), null);
	assert.equal(parseTwoWayInput({ ...TWO_WAY_OFF, kiteFlags: "on" }), null);
	assert.equal(parseTwoWayInput({}), null);
	assert.equal(parseTwoWayInput(null), null);
});

test("each kind of action follows its own setting", () => {
	const on = { ...TWO_WAY_OFF, kiteDelete: "trash" };
	assert.equal(actionAllowed(on, "trash"), true);
	for (const kind of ["archive", "spam", "flags"]) assert.equal(actionAllowed(on, kind), false);
	assert.deepEqual(kiteMove("trash"), { kind: "trash" });
	assert.deepEqual(kiteMove("archived"), { kind: "archive" });
	assert.deepEqual(kiteMove("spam"), { kind: "spam" });
	assert.deepEqual(kiteMove("received"), { kind: "other" });
});

test("what a server supports: MOVE, the UIDPLUS fallback, or no moves at all", () => {
	const listed = [folder("INBOX"), folder("Trash", "\\Trash"), folder("Junk", "\\Junk"), folder("Old", "\\Archive")];
	const support = planProviderSupport(["IMAP4REV1", "MOVE"], listed, NOW);
	assert.equal(support.moveMethod, "move");
	assert.equal(moveTarget(support, "trash"), "Trash");
	assert.equal(moveTarget(support, "spam"), "Junk");
	assert.equal(moveTarget(support, "archive"), "Old");
	assert.equal(planProviderSupport(["UIDPLUS"], listed, NOW).moveMethod, "copy");
	const none = planProviderSupport(["IMAP4REV1"], listed, NOW);
	assert.equal(none.moveMethod, null);
	assert.equal(moveTarget(none, "trash"), null);
	assert.match(twoWaySupportProblem({ ...TWO_WAY_OFF, kiteDelete: "trash" }, none), /cannot move a message safely/);
	assert.equal(twoWaySupportProblem({ ...TWO_WAY_OFF, kiteFlags: true, providerGone: "trash" }, none), null);
	assert.match(twoWaySupportProblem({ ...TWO_WAY_OFF, kiteDelete: "trash" }, null), /could not ask/);
});

test("Gmail archives by moving to All Mail; elsewhere only a real Archive folder counts", () => {
	const gmail = planProviderSupport(
		["X-GM-EXT-1", "MOVE"],
		[
			folder("INBOX"),
			folder("[Gmail]", "\\Noselect"),
			folder("[Gmail]/All Mail", "\\All"),
			folder("[Gmail]/Trash", "\\Trash"),
			folder("[Gmail]/Spam", "\\Junk"),
		],
		NOW,
	);
	assert.equal(gmail.gmail, true);
	assert.equal(gmail.archiveFolder, "[Gmail]/All Mail");
	assert.equal(gmail.trashFolder, "[Gmail]/Trash");
	assert.equal(gmail.junkFolder, "[Gmail]/Spam");
	const other = planProviderSupport(["MOVE"], [folder("INBOX"), folder("Archive"), folder("Trash")], NOW);
	assert.equal(other.archiveFolder, null, "a folder merely named Archive is not offered");
	assert.equal(other.trashFolder, "Trash", "a top-level Trash by name is the honest fallback");
	assert.match(twoWaySupportProblem({ ...TWO_WAY_OFF, kiteArchive: "archive" }, other), /no Archive folder/);
	const nested = planProviderSupport(["MOVE"], [folder("INBOX"), folder("Clients/Trash")], NOW);
	assert.equal(nested.trashFolder, null, "a user's own folder further down never counts");
});

test("the Message-ID check tolerates brackets, not another message", () => {
	assert.equal(sameMessageId("<a@b>", "a@b"), true);
	assert.equal(sameMessageId(" <a@b> ", "<a@b>"), true);
	assert.equal(sameMessageId("<a@b>", "<c@b>"), false);
	assert.equal(sameMessageId(null, null), false, "a message without a Message-ID proves nothing");
	assert.equal(sameMessageId("<a@b>", null), false);
	assert.equal(sameMessageId(null, "<a@b>"), false);
});

const target = (overrides = {}) => ({
	messageId: "m1",
	accountId: "a1",
	mailboxId: "b1",
	settings: { ...TWO_WAY_OFF, kiteDelete: "trash", kiteFlags: true },
	inAccountMailbox: true,
	rfcMessageId: "<a@b>",
	place: { role: "inbox", uidvalidity: 7, uid: 42 },
	...overrides,
});

test("an action becomes an outbox row only with its setting on, for mail in the account's mailbox with a known place", () => {
	const row = planOutbox([target()], { kind: "trash" }).writes[0];
	assert.equal(row.id, moveActionId("m1"));
	assert.equal(row.uid, 42);
	assert.equal(row.rfcMessageId, "<a@b>");
	assert.deepEqual(planOutbox([target()], { kind: "archive" }), { writes: [], cancels: [moveActionId("m1")] });
	assert.equal(planOutbox([target({ inAccountMailbox: false })], { kind: "trash" }).writes.length, 0);
	assert.equal(planOutbox([target({ place: null })], { kind: "trash" }).writes.length, 0);
	assert.equal(planOutbox([target({ inAccountMailbox: false })], { kind: "flags", read: true }).writes.length, 0);
	const flags = planOutbox([target()], { kind: "flags", starred: true }).writes[0];
	assert.equal(flags.id, flagsActionId("m1"));
	assert.equal(flags.read, null);
	assert.equal(flags.starred, true);
});

test("a delete out of Kite's Spam counts only for mail from the provider's Spam folder", () => {
	const inbox = target();
	const junk = target({ place: { role: "junk", uidvalidity: 7, uid: 42 } });
	assert.equal(planOutbox([inbox], { kind: "trash", junkOnly: true }).writes.length, 0);
	assert.equal(planOutbox([junk], { kind: "trash", junkOnly: true }).writes.length, 1);
});

test("any other move cancels a move still waiting, so an Undo wins", () => {
	assert.deepEqual(planOutbox([target()], { kind: "other" }), { writes: [], cancels: [moveActionId("m1")] });
});

const row = (overrides = {}) => ({
	id: "m1:flags",
	accountId: "a1",
	messageId: "m1",
	kind: "flags",
	read: true,
	starred: null,
	role: "inbox",
	uidvalidity: 7,
	uid: 42,
	rfcMessageId: "<a@b>",
	createdAt: new Date("2026-11-06T11:58:00Z"),
	attempts: 0,
	step: 0,
	providerRead: false,
	providerStarred: false,
	...overrides,
});
const fact = (overrides = {}) => ({ messageId: "<a@b>", read: false, starred: false, ...overrides });
const context = { providerFlags: false, lastPassAt: null };

test("a write-back acts only on the same message: a gone UID is finished, another message is never touched", () => {
	const gone = planWriteback([row({ id: "x", kind: "trash" })], new Map(), context);
	assert.equal(gone.missing.length, 1);
	assert.equal(gone.moves.length, 0);
	const other = planWriteback(
		[row({ kind: "trash" }), row({ id: "b", uid: 43, kind: "flags" })],
		new Map([
			[42, fact({ messageId: "<other@b>" })],
			[43, fact({ messageId: "<other@b>" })],
		]),
		context,
	);
	assert.equal(other.mismatched.length, 2);
	assert.deepEqual(other.stores, []);
	assert.deepEqual(other.moves, []);
});

test("a write-back groups by command, stores only what differs and removes a flag with a minus", () => {
	const plan = planWriteback(
		[
			row({ id: "a", messageId: "m1", uid: 1, read: true }),
			row({ id: "b", messageId: "m2", uid: 2, read: true }),
			row({ id: "c", messageId: "m3", uid: 3, read: false, providerRead: true }),
			row({ id: "d", messageId: "m4", uid: 4, read: null, starred: true }),
			row({ id: "e", messageId: "m5", uid: 5, read: true, providerRead: true }),
			row({ id: "f", messageId: "m6", uid: 6, kind: "trash", read: null }),
			row({ id: "g", messageId: "m7", uid: 7, kind: "archive", read: null }),
		],
		new Map([
			[1, fact()],
			[2, fact()],
			[3, fact({ read: true })],
			[4, fact()],
			[5, fact({ read: true })],
			[6, fact()],
			[7, fact()],
		]),
		context,
	);
	const uids = (rows) => rows.map((entry) => entry.uid);
	assert.deepEqual(
		plan.stores.map((group) => [group.change, group.flag, uids(group.rows)]),
		[
			["+", "\\Seen", [1, 2]],
			["-", "\\Seen", [3]],
			["+", "\\Flagged", [4]],
		],
	);
	assert.deepEqual(
		plan.moves.map((group) => [group.kind, uids(group.rows)]),
		[
			["trash", [6]],
			["archive", [7]],
		],
	);
	assert.equal(plan.flags.length, 5, "a row already right at the provider still finishes");
});

test("last writer wins: only a change seen after an older Kite action beats it", () => {
	const lastPassAt = new Date("2026-11-06T11:59:00Z");
	const older = { createdAt: new Date("2026-11-06T11:58:00Z") };
	const newer = { createdAt: new Date("2026-11-06T11:59:30Z") };
	assert.equal(providerIsNewer(older, true, false, lastPassAt), true);
	assert.equal(providerIsNewer(newer, true, false, lastPassAt), false, "a later Kite action stands");
	assert.equal(providerIsNewer(older, false, false, lastPassAt), false, "the provider did not change");
	assert.equal(providerIsNewer(older, true, null, lastPassAt), false, "never compared: nothing to go by");
	assert.equal(providerIsNewer(older, true, false, null), false);

	const stale = planWriteback(
		[row({ read: false, createdAt: older.createdAt, providerRead: false })],
		new Map([[42, fact({ read: true })]]),
		{ providerFlags: true, lastPassAt },
	);
	assert.deepEqual(stale.stores, [], "the provider's newer value is left alone");
	assert.equal(stale.flags[0].read, false, "and the last-seen state too, so the pass still brings it to Kite");
	const fresh = planWriteback(
		[row({ read: false, createdAt: newer.createdAt, providerRead: false })],
		new Map([[42, fact({ read: true })]]),
		{ providerFlags: true, lastPassAt },
	);
	assert.deepEqual(fresh.stores[0].change, "-");
	const oneWay = planWriteback(
		[row({ read: false, createdAt: older.createdAt, providerRead: false })],
		new Map([[42, fact({ read: true })]]),
		{ providerFlags: false, lastPassAt },
	);
	assert.equal(oneWay.stores.length, 1, "with provider-to-Kite off nothing speaks for the provider's value");
});

test("a provider change is split by last writer", () => {
	const lastPassAt = new Date("2026-11-06T11:59:00Z");
	const change = { messageId: "m1", uid: 1, read: true, starred: true, provider: { read: true, starred: true } };
	assert.deepEqual(resolveFlagChange(change, undefined, lastPassAt), {
		kite: { read: true, starred: true },
		dropped: [],
	});
	const older = { createdAt: new Date("2026-11-06T11:58:00Z"), read: false, starred: null };
	assert.deepEqual(resolveFlagChange(change, older, lastPassAt), {
		kite: { read: true, starred: true },
		dropped: ["read"],
	});
	const newer = { createdAt: new Date("2026-11-06T11:59:30Z"), read: false, starred: null };
	assert.deepEqual(resolveFlagChange(change, newer, lastPassAt), { kite: { starred: true }, dropped: [] });
});

const ref = (uid, overrides = {}) => ({
	messageId: `m${uid}`,
	uid,
	providerRead: false,
	providerStarred: false,
	missing: false,
	...overrides,
});
const reconcile = (overrides = {}) =>
	planReconcile({
		refs: [],
		seen: new Map(),
		believed: true,
		syncGone: true,
		syncFlags: true,
		adoptGone: false,
		adoptFlags: false,
		pendingMoves: new Set(),
		...overrides,
	});
const flags = (read = false, starred = false) => ({ read, starred });

test("a pass finds what left and what changed, and nothing else", () => {
	const plan = reconcile({
		refs: [ref(1), ref(2), ref(3, { providerStarred: true })],
		seen: new Map([
			[2, flags(true)],
			[3, flags(false, true)],
		]),
	});
	assert.deepEqual(plan.newlyMissing, ["m1"], "absent for the first time is only noted");
	assert.deepEqual(plan.candidates, []);
	assert.deepEqual(plan.flagChanges, [
		{ messageId: "m2", uid: 2, read: true, provider: { read: true, starred: false } },
	]);
	assert.deepEqual(plan.baselines, []);
});

test("a baseline records what is there and changes nothing in Kite", () => {
	const plan = reconcile({
		refs: [ref(1), ref(2)],
		seen: new Map([[2, flags(true)]]),
		adoptGone: true,
		adoptFlags: true,
	});
	assert.deepEqual(plan.newlyMissing, []);
	assert.deepEqual(plan.silentlyGone, ["m1"]);
	assert.deepEqual(plan.flagChanges, []);
	assert.deepEqual(plan.baselines, [{ messageId: "m2", read: true, starred: false }]);
});

test("a row never compared with the server is adopted, even outside a baseline", () => {
	const plan = reconcile({
		refs: [
			ref(1, { providerRead: null, providerStarred: null }),
			ref(2, { providerRead: null, providerStarred: null }),
		],
		seen: new Map([[2, flags(true, true)]]),
	});
	assert.deepEqual(plan.newlyMissing, []);
	assert.deepEqual(plan.silentlyGone, ["m1"]);
	assert.deepEqual(plan.baselines, [{ messageId: "m2", read: true, starred: true }]);
});

test("a message with a move waiting is never counted as gone: that is Kite's own move", () => {
	const plan = reconcile({ refs: [ref(1)], pendingMoves: new Set(["m1"]) });
	assert.deepEqual(plan.newlyMissing, []);
	assert.deepEqual(plan.silentlyGone, []);
});

test("with a direction off, that direction changes nothing", () => {
	const onlyGone = reconcile({ refs: [ref(1)], seen: new Map([[1, flags(true)]]), syncFlags: false });
	assert.deepEqual(onlyGone.flagChanges, []);
	const onlyFlags = reconcile({ refs: [ref(1)], syncGone: false });
	assert.deepEqual(onlyFlags.newlyMissing, []);
	assert.deepEqual(onlyFlags.silentlyGone, ["m1"]);
});

test("only a second session's absence makes a candidate, and being seen again takes the note back", () => {
	const second = reconcile({
		refs: [ref(1, { missing: true }), ref(2, { missing: true })],
		seen: new Map([[2, flags()]]),
	});
	assert.deepEqual(second.candidates, [{ messageId: "m1", uid: 1 }]);
	assert.deepEqual(second.newlyMissing, []);
	assert.deepEqual(second.found, ["m2"]);
});

test("an answer that is not believed says nothing about what is absent; flags still count", () => {
	const plan = reconcile({
		refs: [ref(1), ref(2, { missing: true }), ref(3, { providerRead: null, providerStarred: null }), ref(4)],
		seen: new Map([[4, flags(true)]]),
		believed: false,
	});
	assert.deepEqual(plan.newlyMissing, []);
	assert.deepEqual(plan.candidates, []);
	assert.deepEqual(plan.silentlyGone, []);
	assert.equal(plan.flagChanges.length, 1);
});

const answer = (from, count) => Array.from({ length: count }, (_, index) => ({ seq: from + index }));

test("the answer's count must add up to EXISTS", () => {
	const judge = (overrides) =>
		judgeAnswer({
			exists: 100,
			uidNext: 101,
			tracked: 100,
			high: 100,
			answered: answer(1, 100),
			baseline: false,
			...overrides,
		});
	assert.equal(judge({}), null);
	assert.equal(judge({ exists: 0, answered: [] }), "empty_folder", "49 tracked and EXISTS 0 trashes nothing");
	assert.equal(judge({ exists: 0, tracked: 1, answered: [] }), "empty_folder");
	assert.equal(judge({ exists: 40, answered: answer(1, 40) }), "far_below");
	assert.equal(judge({ exists: 3, tracked: 9, answered: answer(1, 3) }), null, "a small Inbox may really shrink");
	assert.equal(judge({ exists: 60, tracked: 100, answered: answer(1, 60) }), null);
	assert.equal(judge({ exists: null }), "partial");
	assert.equal(judge({ answered: [] }), "partial", "an empty answer from a folder that is not empty");
	assert.equal(judge({ answered: answer(1, 30) }), "partial", "a cap");
	assert.equal(judge({ answered: answer(1, 99) }), "partial", "one line short");
	assert.equal(judge({ answered: answer(11, 90) }), null, "ten older messages sit before the range");
	assert.equal(judge({ exists: 103, uidNext: 104, answered: answer(1, 100) }), null, "new mail after the range");
	assert.equal(judge({ exists: 103, uidNext: null, answered: answer(1, 100) }), "partial");
	assert.equal(judge({ tracked: 0, exists: 0, answered: [] }), null, "nothing tracked, nothing to judge");
	assert.equal(judge({ exists: 0, answered: [], baseline: true }), null, "the owner asked to start over");
	assert.equal(judge({ exists: 40, answered: answer(1, 40), baseline: true }), null);
	assert.equal(judge({ answered: answer(1, 30), baseline: true }), "partial", "a cut answer stays a cut answer");
	assert.equal(judge({ exists: null, baseline: true }), "partial");
	assert.equal(judge({ answered: [], baseline: true }), "partial");
});

test("a pass stops at its limit and says so, so the next one runs", () => {
	const refs = Array.from({ length: 10 }, (_, index) => ref(index + 1));
	const plan = reconcile({ refs: refs.map((entry) => ({ ...entry, missing: true })), maxChanges: 3 });
	assert.equal(plan.candidates.length, 3);
	assert.equal(plan.truncated, true);
});

test("a pass is skipped only when CONDSTORE and the folder's counts all agree", () => {
	const last = { uidvalidity: 7, highestModseq: "10", existsCount: 5, uidNext: 9 };
	const now = { uidValidity: 7, highestModseq: "10", exists: 5, uidNext: 9 };
	assert.equal(nothingChanged(last, now), true);
	assert.equal(nothingChanged(last, { ...now, highestModseq: "11" }), false);
	assert.equal(nothingChanged(last, { ...now, exists: 4 }), false, "an expunge need not raise the modseq");
	assert.equal(nothingChanged(last, { ...now, uidNext: 10 }), false);
	assert.equal(nothingChanged(last, { ...now, uidValidity: 8 }), false);
	assert.equal(nothingChanged({ ...last, highestModseq: null }, { ...now, highestModseq: null }), false);
});

test("retries back off and end", () => {
	assert.equal(writebackRetryMs(1), 5 * 60_000);
	assert.equal(writebackRetryMs(2), 15 * 60_000);
	assert.equal(writebackRetryMs(9), 6 * 60 * 60_000);
});
