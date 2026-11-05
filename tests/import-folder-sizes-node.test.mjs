import assert from "node:assert/strict";
import test, { after } from "node:test";
import { startFakeImap, sampleMessage } from "./support/fake-imap.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Measuring a folder's size for the import page when the server has no STATUS=SIZE: UID FETCH (RFC822.SIZE) over UID
// windows, newest first, in bounded steps the page repeats; and how the page adds the rows up.

const bundle = await bundleModules("kite-import-folder-sizes-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["measureFolderStep", "src/lib/import/folder-sizes.ts"],
	["planAccountImport", "src/lib/import/imap.ts"],
	["nextSizeWindow, parseSizeCursor, sizeProgress, sumSizes, maxSizeSteps", "src/lib/import/folder-size-utils.ts"],
	[
		"foldersToMeasure, plannedTotals, plannedFolderSize, withMeasuredBytes, importSizeNotes",
		"src/app/(import)/settings/import/size-utils.ts",
	],
]);

const { createTcpConnect, measureFolderStep, planAccountImport } = bundle;
const utils = bundle;
const page = bundle;

const HOST = "imap.kite.test";
const account = { host: HOST, port: 993, secure: true, username: "user@example.test", password: "app-password" };
const tls = createTestCertificate([HOST]);

async function fake(t, options) {
	const server = await startFakeImap({ tls, implicitTls: true, authPlain: true, saslIr: true, ...options });
	t.after(() => server.close());
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const env = {
		KITE_RUNTIME: "node",
		TCP_CONNECT: (address, options) => connect({ ...address, port: server.port }, options),
	};
	return { server, env };
}

/** What the page does: steps until `nextCursor` is null, adding them up. */
async function measureAll(env, folder, limits) {
	let cursor = null;
	let messages = 0;
	let bytes = 0;
	let steps = 0;
	do {
		const step = await measureFolderStep(env, account, folder, cursor, limits);
		assert.ok(step, "the server names a UIDNEXT");
		messages += step.messages;
		bytes += step.bytes;
		cursor = step.nextCursor;
		steps += 1;
	} while (cursor !== null && steps < 100);
	return { messages, bytes, steps };
}

const SMALL = { windowMessages: 10, stepMessages: 10, maxWindows: 50, maxMs: 60_000 };

test("a folder is measured in steps whose sums are the folder's size", async (t) => {
	const messages = Array.from({ length: 35 }, (_, index) => ({
		raw: sampleMessage(index + 1),
		size: 1000 + index,
	}));
	const { server, env } = await fake(t, { folders: { INBOX: messages } });
	const expected = messages.reduce((sum, message) => sum + message.size, 0);
	const result = await measureAll(env, "INBOX", SMALL);
	assert.equal(result.messages, 35);
	assert.equal(result.bytes, expected);
	// Windows of 10 messages and steps of 10 messages: four steps for 35 messages.
	assert.equal(result.steps, 4);
	// Only attributes were asked for, never a body.
	const fetches = server.commands.filter((entry) => /\bFETCH\b/i.test(entry.line));
	assert.ok(fetches.length >= 4);
	assert.ok(fetches.every((entry) => !/BODY/i.test(entry.line) && /RFC822\.SIZE/.test(entry.line)));
});

test("the first step is the newest window and its cursor moves down", async (t) => {
	const { env } = await fake(t, {
		folders: { INBOX: Array.from({ length: 25 }, (_, index) => ({ raw: sampleMessage(index + 1), size: 100 })) },
	});
	const first = await measureFolderStep(env, account, "INBOX", null, { ...SMALL, maxWindows: 1 });
	assert.equal(first.messages, 10);
	assert.equal(first.exists, 25);
	assert.equal(first.uidValidity, 1);
	assert.equal(first.nextCursor, 15);
	assert.equal(utils.sizeProgress(first.nextCursor, first.exists), 0.4);
	const last = await measureFolderStep(env, account, "INBOX", 5, SMALL);
	assert.equal(last.messages, 5);
	assert.equal(last.nextCursor, null);
	// A cursor above the folder's size (it shrank meanwhile) is clamped instead of asking for numbers that are not there.
	const clamped = await measureFolderStep(env, account, "INBOX", 500, { ...SMALL, maxWindows: 1 });
	assert.equal(clamped.messages, 10);
});

test("a folder with few messages and a huge UIDNEXT is one step, not thousands", async (t) => {
	const { server, env } = await fake(t, {
		folders: {
			INBOX: [
				{ raw: sampleMessage(1), size: 100, uid: 4_000_000 },
				{ raw: sampleMessage(2), size: 200, uid: 7_000_000 },
			],
		},
	});
	const result = await measureAll(env, "INBOX");
	assert.deepEqual(
		{ messages: result.messages, bytes: result.bytes, steps: result.steps },
		{ messages: 2, bytes: 300, steps: 1 },
	);
	assert.equal(server.commands.filter((entry) => /\bFETCH\b/i.test(entry.line)).length, 1);
});

test("an empty folder is done at once, and a message without a size is counted as unsized", async (t) => {
	const { env } = await fake(t, {
		folders: {
			Empty: [],
			Odd: [
				{ raw: sampleMessage(1), size: null },
				{ raw: sampleMessage(2), size: 500 },
			],
		},
	});
	const empty = await measureFolderStep(env, account, "Empty", null);
	assert.deepEqual({ ...empty }, { messages: 0, bytes: 0, unsized: 0, nextCursor: null, exists: 0, uidValidity: 1 });
	const odd = await measureFolderStep(env, account, "Odd", null);
	assert.deepEqual({ ...odd }, { messages: 2, bytes: 500, unsized: 1, nextCursor: null, exists: 2, uidValidity: 1 });
});

test("an aborted step stops and closes its connection", async (t) => {
	const { env } = await fake(t, {
		fetchGate: new Promise(() => undefined),
		folders: { INBOX: [{ raw: sampleMessage(1), size: 10 }] },
	});
	const controller = new AbortController();
	const running = measureFolderStep(env, account, "INBOX", null, undefined, undefined, controller.signal);
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(running);
});

test("a missing folder fails the step, which the page shows as unavailable", async (t) => {
	const { env } = await fake(t, {});
	await assert.rejects(measureFolderStep(env, account, "Nope", null));
});

test("STATUS=SIZE servers give the size in the plan, so nothing is measured for them", async (t) => {
	const { env } = await fake(t, {
		statusSize: true,
		folders: { INBOX: [{ raw: sampleMessage(1), size: 10 }] },
	});
	const plan = await planAccountImport(env, account);
	assert.equal(plan.folders[0].messages, 1);
	assert.ok(plan.folders[0].bytes > 0);
	assert.deepEqual(page.foldersToMeasure(plan.folders), []);
	const without = await fake(t, { folders: { INBOX: [{ raw: sampleMessage(1) }] } });
	const planWithout = await planAccountImport(without.env, account);
	assert.equal(planWithout.folders[0].bytes, null);
	assert.deepEqual(page.foldersToMeasure(planWithout.folders), [{ name: "INBOX", messages: 1 }]);
});

test("window and cursor helpers", () => {
	assert.deepEqual(utils.nextSizeWindow(null, 100, 50), { from: 51, to: 100 });
	assert.deepEqual(utils.nextSizeWindow(50, 100, 50), { from: 1, to: 50 });
	assert.deepEqual(utils.nextSizeWindow(7, 100, 50), { from: 1, to: 7 });
	assert.equal(utils.nextSizeWindow(null, 0, 50), null);
	assert.equal(utils.nextSizeWindow(0, 100, 50), null);
	// A cursor above the folder's size (it shrank meanwhile) is clamped.
	assert.deepEqual(utils.nextSizeWindow(500, 10, 50), { from: 1, to: 10 });
	// Steps are bounded by the folder's size: one per 10,000 messages plus slack, never more than 100.
	assert.equal(utils.maxSizeSteps(100_000), 13);
	assert.equal(utils.maxSizeSteps(5), 4);
	assert.equal(utils.maxSizeSteps(null), 100);
	assert.equal(utils.maxSizeSteps(50_000_000), 100);
	assert.equal(utils.parseSizeCursor("12"), 12);
	for (const bad of [undefined, null, 0, -3, 1.5, "x", Number.NaN]) assert.equal(utils.parseSizeCursor(bad), null);
	assert.equal(utils.sizeProgress(null, 100), 1);
	assert.equal(utils.sizeProgress(99, 100), 0.01);
	assert.deepEqual(utils.sumSizes([{ size: 5 }, { size: null }, { size: -2 }, { size: 7 }]), {
		messages: 4,
		bytes: 12,
		unsized: 2,
	});
});

const row = (sourceName, include, messages, bytes) => ({
	sourceName,
	displayName: sourceName,
	role: "user",
	include,
	destination: "system:inbox",
	messages,
	bytes,
});

const state = (status, messages, bytes, progress = 1, unsized = 0) => ({ status, messages, bytes, unsized, progress });

test("the totals add up exact sizes, call a partly measured sum an estimate and hold back an unknown one", () => {
	const folders = [row("A", true, 100, 1000), row("B", true, 200, null), row("C", false, 50, null)];
	const totals = (sizes, list = folders) => ({ ...page.plannedTotals(list, sizes) });
	assert.deepEqual(totals({ B: state("done", 200, 4000) }), {
		messages: 300,
		bytes: 5000,
		sizeKind: "exact",
		measuring: 0,
		unavailable: 0,
		failed: 0,
	});
	// Halfway through B: 50 messages weighed 1000, so B is about 4000 and the total is an estimate.
	assert.deepEqual(totals({ B: state("measuring", 50, 1000, 0.25) }), {
		messages: 300,
		bytes: 5000,
		sizeKind: "estimated",
		measuring: 1,
		unavailable: 0,
		failed: 0,
	});
	// Nothing counted yet: no number, and the folder is waiting.
	const waiting = totals({});
	assert.equal(waiting.bytes, null);
	assert.equal(waiting.sizeKind, "unknown");
	assert.equal(waiting.measuring, 1);
	// The server cannot measure B, or a step failed: the folder is named, the size stays unknown.
	const unavailable = totals({ B: state("unavailable", 0, 0, 0) });
	assert.deepEqual([unavailable.bytes, unavailable.unavailable, unavailable.failed], [null, 1, 0]);
	const failed = totals({ B: state("failed", 80, 100, 0.3) });
	assert.deepEqual([failed.bytes, failed.unavailable, failed.failed], [null, 0, 1]);
	// Ticking C adds a folder that is not measured yet.
	assert.equal(
		totals({ B: state("done", 200, 4000) }, [...folders.slice(0, 2), row("C", true, 50, null)]).measuring,
		1,
	);
	// An empty folder weighs nothing without being measured; a folder without a count is still measured.
	assert.equal(page.plannedFolderSize(row("E", true, 0, null), undefined).bytes, 0);
	assert.deepEqual(
		page.foldersToMeasure([row("F", true, null, null), row("G", true, 0, null), row("H", false, 3, null)]),
		[{ name: "F", messages: null }],
	);
	assert.equal(page.plannedFolderSize(row("F", true, null, null), state("done", 12, 3000)).bytes, 3000);
});

test("messages without a size make a folder an estimate, and no sizes at all make it unknown", () => {
	const folder = row("A", true, 100, null);
	// 80 of 100 messages weighed 8000 bytes: scaled to the folder, not shown as exact.
	assert.deepEqual(
		{ ...page.plannedFolderSize(folder, state("done", 100, 8000, 1, 20)) },
		{
			kind: "estimated",
			bytes: 10_000,
			progress: 1,
		},
	);
	assert.equal(page.plannedFolderSize(folder, state("done", 100, 0, 1, 100)).kind, "unknown");
	const totals = page.plannedTotals([folder], { A: state("done", 100, 8000, 1, 20) });
	assert.deepEqual([totals.sizeKind, totals.bytes, totals.measuring], ["estimated", 10_000, 0]);
	const none = page.plannedTotals([folder], { A: state("done", 100, 0, 1, 100) });
	assert.deepEqual([none.bytes, none.unavailable], [null, 1]);
});

test("a measured folder goes to the job with its size, an estimate does not", () => {
	const folders = [row("A", true, 100, null), row("B", true, 100, null), row("C", true, 100, null)];
	const sent = page.withMeasuredBytes(folders, {
		A: state("done", 100, 777),
		B: state("measuring", 10, 50, 0.1),
		C: state("done", 100, 50, 1, 50),
	});
	assert.deepEqual(
		sent.map((entry) => entry.bytes),
		[777, null, null],
	);
});

test("the notes under the totals say what is still going on and why totals are an upper bound", () => {
	const totals = { messages: 10, bytes: null, sizeKind: "unknown", measuring: 2, unavailable: 1, failed: 3 };
	const notes = page.importSizeNotes(totals, false);
	assert.match(notes[0], /Still measuring 2 folders\. The size is an estimate until that is done/);
	assert.match(notes[1], /did not say how big 1 folder is, so the size stays unknown/);
	assert.match(notes[2], /Measuring 3 folders did not work just now.*Tick them again or read the folders again/);
	assert.match(notes[3], /copied once \(matched by Message-ID\), so these totals are an upper bound/);
	const gmail = page.importSizeNotes({ ...totals, measuring: 0, unavailable: 0, failed: 0 }, true);
	assert.equal(gmail.length, 1);
	assert.match(gmail[0], /Gmail's All Mail/);
});

after(() => undefined);
