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
	["nextSizeWindow, parseSizeCursor, sizeProgress, sumSizes", "src/lib/import/folder-size-utils.ts"],
	[
		"foldersToMeasure, plannedTotals, plannedFolderSize, withMeasuredBytes, importSizeNotes",
		"src/app/(import)/settings/import/utils.ts",
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

const SMALL = { windowUids: 10, stepMessages: 10, maxWindows: 50, maxMs: 60_000 };

test("aborting a measuring request closes a stalled IMAP fetch without starting another window", async (t) => {
	const controller = new AbortController();
	let release;
	let fetching;
	const started = new Promise((resolve) => (fetching = resolve));
	const gate = new Promise((resolve) => (release = resolve));
	const { env, server } = await fake(t, {
		fetchGate: () => {
			fetching();
			return gate;
		},
	});
	const step = measureFolderStep(env, account, "INBOX", null, SMALL, { signal: controller.signal });
	await started;
	controller.abort();
	try {
		await assert.rejects(step);
		assert.equal(server.commands.filter((entry) => /UID FETCH/i.test(entry.line)).length, 1);
	} finally {
		release();
	}
});

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
	// Windows of 10 UIDs and steps of 10 messages: four steps for 35 messages.
	assert.equal(result.steps, 4);
	// Only attributes were asked for, never a body.
	const fetches = server.commands.filter((entry) => /UID FETCH/i.test(entry.line ?? entry.command ?? ""));
	assert.ok(fetches.length >= 4);
	assert.ok(fetches.every((entry) => !/BODY/i.test(entry.line ?? entry.command ?? "")));
});

test("the first step is the newest window and its cursor moves down", async (t) => {
	const { env } = await fake(t, {
		folders: { INBOX: Array.from({ length: 25 }, (_, index) => ({ raw: sampleMessage(index + 1), size: 100 })) },
	});
	const first = await measureFolderStep(env, account, "INBOX", null, { ...SMALL, maxWindows: 1 });
	assert.equal(first.messages, 10);
	assert.equal(first.uidNext, 26);
	assert.equal(first.nextCursor, 15);
	assert.equal(utils.sizeProgress(first.nextCursor, first.uidNext), 0.4);
	const last = await measureFolderStep(env, account, "INBOX", 5, SMALL);
	assert.equal(last.messages, 5);
	assert.equal(last.nextCursor, null);
});

test("a changed UIDVALIDITY restarts at the newest window instead of reusing an older cursor", async (t) => {
	const { env, server } = await fake(t, {
		folders: { INBOX: Array.from({ length: 25 }, (_, index) => ({ raw: sampleMessage(index + 1), size: 100 })) },
	});
	const limits = { ...SMALL, maxWindows: 1 };
	const first = await measureFolderStep(env, account, "INBOX", null, limits);
	server.bumpUidValidity("INBOX");
	const restarted = await measureFolderStep(env, account, "INBOX", first.nextCursor, limits, {
		uidValidity: first.uidValidity,
	});
	assert.equal(restarted.reset, true);
	assert.equal(restarted.uidValidity, 2);
	assert.equal(restarted.nextCursor, first.nextCursor);
	const continued = await measureFolderStep(env, account, "INBOX", restarted.nextCursor, limits, {
		uidValidity: restarted.uidValidity,
	});
	assert.equal(continued.reset, false);
	assert.equal(continued.nextCursor, 5);
});

test("an empty folder is done at once, but missing sizes make the measurement unavailable", async (t) => {
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
	assert.deepEqual({ ...empty }, { messages: 0, bytes: 0, nextCursor: null, uidNext: 1, uidValidity: 1, reset: false });
	const odd = await measureFolderStep(env, account, "Odd", null);
	assert.equal(odd, null);
});

test("a server that names no UIDNEXT on EXAMINE is asked with STATUS instead", async (t) => {
	const { env } = await fake(t, {
		omitUidNext: true,
		folders: { INBOX: Array.from({ length: 12 }, (_, index) => ({ raw: sampleMessage(index + 1), size: 10 })) },
	});
	const result = await measureAll(env, "INBOX", SMALL);
	assert.equal(result.bytes, 120);
});

test("a missing folder fails the step, which the page shows as unavailable", async (t) => {
	const { env } = await fake(t, {});
	await assert.rejects(measureFolderStep(env, account, "Nope", null));
});

test("the total UID walk is bounded across requests, not only within each step", async (t) => {
	const { server, env } = await fake(t, {
		folders: { INBOX: Array.from({ length: 25 }, (_, index) => ({ raw: sampleMessage(index + 1), size: 100 })) },
	});
	const limits = { ...SMALL, maxWindows: 1, maxFolderUids: 10 };
	const first = await measureFolderStep(env, account, "INBOX", null, limits);
	assert.equal(first.nextCursor, 15);
	assert.equal(await measureFolderStep(env, account, "INBOX", first.nextCursor, limits), null);
	assert.equal(server.commands.filter((entry) => /UID FETCH/i.test(entry.line)).length, 1);
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
	assert.deepEqual(page.foldersToMeasure(planWithout.folders), ["INBOX"]);
});

test("window and cursor helpers", () => {
	assert.deepEqual(utils.nextSizeWindow(null, 101, 50), { from: 51, to: 100 });
	assert.deepEqual(utils.nextSizeWindow(50, 101, 50), { from: 1, to: 50 });
	assert.deepEqual(utils.nextSizeWindow(7, 101, 50), { from: 1, to: 7 });
	assert.equal(utils.nextSizeWindow(null, 1, 50), null);
	assert.equal(utils.nextSizeWindow(0, 101, 50), null);
	// A cursor above UIDNEXT (the folder was emptied meanwhile) is clamped.
	assert.deepEqual(utils.nextSizeWindow(500, 11, 50), { from: 1, to: 10 });
	assert.equal(utils.parseSizeCursor("12"), 12);
	for (const bad of [undefined, null, 0, -3, 1.5, "x", Number.NaN]) assert.equal(utils.parseSizeCursor(bad), null);
	assert.equal(utils.sizeProgress(null, 100), 1);
	assert.equal(utils.sizeProgress(99, 101), 0.01);
	assert.deepEqual(utils.sumSizes([{ size: 5 }, { size: null }, { size: -2 }, { size: 7 }]), {
		messages: 4,
		bytes: 12,
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

test("the totals add up exact sizes, call a partly measured sum an estimate and hold back an unknown one", () => {
	const folders = [row("A", true, 100, 1000), row("B", true, 200, null), row("C", false, 50, null)];
	const done = { B: { status: "done", messages: 200, bytes: 4000, progress: 1 } };
	assert.deepEqual(
		{ ...page.plannedTotals(folders, done) },
		{
			messages: 300,
			bytes: 5000,
			sizeKind: "exact",
			measuring: 0,
			unavailable: 0,
		},
	);
	// Halfway through B: 50 messages weighed 1000, so B is about 4000 and the total is an estimate.
	const partial = { B: { status: "measuring", messages: 50, bytes: 1000, progress: 0.25 } };
	assert.deepEqual(
		{ ...page.plannedTotals(folders, partial) },
		{
			messages: 300,
			bytes: 5000,
			sizeKind: "estimated",
			measuring: 1,
			unavailable: 0,
		},
	);
	// Nothing counted yet: no number, and the folder is waiting.
	const waiting = page.plannedTotals(folders, {});
	assert.equal(waiting.bytes, null);
	assert.equal(waiting.sizeKind, "unknown");
	assert.equal(waiting.measuring, 1);
	// The server could not measure B: its folder is named, the import is not affected.
	const failed = page.plannedTotals(folders, { B: { status: "unavailable", messages: 0, bytes: 0, progress: 0 } });
	assert.equal(failed.bytes, null);
	assert.equal(failed.unavailable, 1);
	// Ticking C adds a folder that is not measured yet.
	assert.equal(page.plannedTotals([...folders.slice(0, 2), row("C", true, 50, null)], done).measuring, 1);
	// An empty folder weighs nothing; an unknown count still permits a UID-based measurement.
	assert.equal(page.plannedFolderSize(row("E", true, 0, null), undefined).bytes, 0);
	assert.equal(page.plannedTotals([row("F", true, null, null)], {}).measuring, 1);
	assert.deepEqual(page.foldersToMeasure([row("F", true, null, null), row("E", true, 0, null)]), ["F"]);
});

test("a measured folder goes to the job with its size, an estimate does not", () => {
	const folders = [row("A", true, 100, null), row("B", true, 100, null)];
	const sent = page.withMeasuredBytes(folders, {
		A: { status: "done", messages: 100, bytes: 777, progress: 1 },
		B: { status: "measuring", messages: 10, bytes: 50, progress: 0.1 },
	});
	assert.deepEqual(
		sent.map((entry) => entry.bytes),
		[777, null],
	);
});

test("the notes under the totals say what is still going on and why totals are an upper bound", () => {
	const totals = { messages: 10, bytes: null, sizeKind: "unknown", measuring: 2, unavailable: 1 };
	const notes = page.importSizeNotes(totals, false);
	assert.match(notes[0], /Still measuring 2 folders\. The size is an estimate until that is done/);
	assert.match(notes[1], /could not say how big 1 folder is, so it is not in the size/);
	assert.match(notes[2], /copied once \(matched by Message-ID\), so these totals are an upper bound/);
	const gmail = page.importSizeNotes({ ...totals, measuring: 0, unavailable: 0 }, true);
	assert.equal(gmail.length, 1);
	assert.match(gmail[0], /Gmail's All Mail/);
});

after(() => undefined);
