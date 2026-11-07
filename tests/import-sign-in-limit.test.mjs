import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-import-sign-in-limit-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/lib/import/sign-in-limit-utils.ts";
			export * from "./src/lib/import/capped-fetch-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "import-sign-in-limit-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	evaluateSignInAttempts,
	signInServerKey,
	SIGN_IN_FAILURES_PER_SERVER,
	SIGN_IN_FAILURES_PER_USER,
	SIGN_IN_WINDOW_MS,
	planFetchSegments,
	isAuthRefusal,
	signInLimitMessage,
	oversizedNote,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const NOW = 1_800_000_000_000;
const MB = 1024 * 1024;

/** `count` attempts at `server`, `ageMs` old each, one second apart (the oldest first). */
function attempts(count, server, ageMs = 60_000) {
	return Array.from({ length: count }, (_, index) => ({ at: NOW - ageMs + index * 1000, server }));
}

test("servers are grouped by host and port without case or a trailing dot", () => {
	assert.equal(signInServerKey("IMAP.Example.com.", 993), "imap.example.com:993");
	assert.notEqual(signInServerKey("imap.example.com", 993), signInServerKey("imap.example.com", 143));
});

test("an attempt is allowed while its user has at most the limit in the window, its own row included", () => {
	const server = signInServerKey("a.example.com", 993);
	assert.deepEqual(evaluateSignInAttempts(attempts(SIGN_IN_FAILURES_PER_SERVER, server), server, NOW), {
		allowed: true,
	});
	const spread = Array.from({ length: SIGN_IN_FAILURES_PER_USER }, (_, index) => ({
		at: NOW - 1000 * (index + 1),
		server: signInServerKey(`host${index}.example.com`, 993),
	}));
	assert.deepEqual(evaluateSignInAttempts(spread, "host0.example.com:993", NOW), { allowed: true });
});

test("past the per-user limit it is refused whatever the server", () => {
	const rows = Array.from({ length: SIGN_IN_FAILURES_PER_USER + 1 }, (_, index) => ({
		at: NOW - 100_000 + index * 1000,
		server: signInServerKey(`host${index}.example.com`, 993),
	}));
	const verdict = evaluateSignInAttempts(rows, "other.example.com:993", NOW);
	assert.equal(verdict.allowed, false);
	// One other failure has to leave the window: the oldest, 100 s old, leaves after 500 s.
	assert.equal(verdict.retryAfterSeconds, 500);
});

test("past the per-server limit it is refused for that server only", () => {
	const server = signInServerKey("a.example.com", 993);
	const other = signInServerKey("b.example.com", 993);
	const rows = attempts(SIGN_IN_FAILURES_PER_SERVER + 1, server, 30_000);
	assert.equal(evaluateSignInAttempts(rows, server, NOW).allowed, false);
	assert.deepEqual(evaluateSignInAttempts(rows, other, NOW), { allowed: true });
});

test("failures older than the window are not counted", () => {
	const server = signInServerKey("a.example.com", 993);
	const old = attempts(50, server, SIGN_IN_WINDOW_MS + 100_000);
	assert.deepEqual(evaluateSignInAttempts(old, server, NOW), { allowed: true });
	// Right at the edge a row still counts only while it is newer than the window.
	const edge = [{ at: NOW - SIGN_IN_WINDOW_MS, server }, ...attempts(SIGN_IN_FAILURES_PER_SERVER, server)];
	assert.deepEqual(evaluateSignInAttempts(edge, server, NOW), { allowed: true });
});

test("the wait is until enough failures have left the window, at least a second, and the longer of the two limits", () => {
	const server = signInServerKey("a.example.com", 993);
	// 8 failures at this server, just inside the window: 3 over the per-server limit, so the 3rd oldest has to leave.
	const rows = Array.from({ length: SIGN_IN_FAILURES_PER_SERVER + 3 }, (_, index) => ({
		at: NOW - SIGN_IN_WINDOW_MS + 10_000 + index * 1000,
		server,
	}));
	const verdict = evaluateSignInAttempts(rows, server, NOW);
	assert.equal(verdict.allowed, false);
	// The row that has to leave is the 3rd oldest (10 s + 2 s into the window): 12 s of the window are used up.
	assert.equal(verdict.retryAfterSeconds, 12);
	const justExpiring = [
		...attempts(SIGN_IN_FAILURES_PER_SERVER, server, 1000),
		{ at: NOW - SIGN_IN_WINDOW_MS + 1, server },
		{ at: NOW - 1, server },
	];
	assert.equal(evaluateSignInAttempts(justExpiring, server, NOW).retryAfterSeconds >= 1, true);
});

test("the refusal says how long to wait in plain words", () => {
	assert.match(signInLimitMessage(30), /try again in a minute/);
	assert.match(signInLimitMessage(61), /try again in 2 minutes/);
	assert.match(signInLimitMessage(600), /try again in 10 minutes/);
});

test("segments are cut by count and by bytes, in order, and each stays within the byte budget", () => {
	const uids = Array.from({ length: 10 }, (_, index) => String(index + 1));
	const sizes = new Map(uids.map((uid) => [uid, 5 * MB]));
	const segments = planFetchSegments(uids, sizes, { messageBytes: 36 * MB, batchBytes: 16 * MB, batchMessages: 25 });
	assert.deepEqual(
		segments.map((segment) => segment.fetch),
		[["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["10"]],
	);
	assert.ok(segments.every((segment) => segment.weight <= 16 * MB));
	const small = new Map(uids.map((uid) => [uid, 1000]));
	const byCount = planFetchSegments(uids, small, { messageBytes: 36 * MB, batchMessages: 4 });
	assert.deepEqual(
		byCount.map((segment) => segment.fetch.length),
		[4, 4, 2],
	);
});

test("25 messages of 15 MB are 25 segments, never one chunk held together", () => {
	const uids = Array.from({ length: 25 }, (_, index) => String(index + 1));
	const sizes = new Map(uids.map((uid) => [uid, 15 * MB]));
	const segments = planFetchSegments(uids, sizes, { messageBytes: 36 * MB });
	assert.equal(segments.length, 25);
	assert.ok(segments.every((segment) => segment.weight <= 16 * MB));
});

test("a message above the cap stays in its segment's UIDs but is not fetched; the others are", () => {
	const sizes = new Map([
		["1", 1000],
		["2", 40 * MB],
		["3", 36 * MB],
		["4", 2000],
	]);
	const segments = planFetchSegments(["1", "2", "3", "4"], sizes, { messageBytes: 36 * MB });
	assert.deepEqual(
		segments.map((segment) => segment.uids),
		[["1", "2"], ["3"], ["4"]],
	);
	assert.deepEqual(
		segments.map((segment) => segment.fetch),
		[["1"], ["3"], ["4"]],
	);
	assert.deepEqual(segments[0].oversized, [{ uid: "2", size: 40 * MB }]);
	// UIDs in order and each exactly once, so the cursor can follow the segments.
	assert.deepEqual(
		segments.flatMap((segment) => segment.uids),
		["1", "2", "3", "4"],
	);
});

test("only oversized messages make a segment with nothing to fetch", () => {
	const segments = planFetchSegments(["1"], new Map([["1", 99 * MB]]), { messageBytes: 36 * MB });
	assert.equal(segments.length, 1);
	assert.deepEqual(segments[0].fetch, []);
	assert.equal(segments[0].weight, 0);
});

test("a message without a stated size is planned at the cap: alone", () => {
	const segments = planFetchSegments(["1", "2"], new Map(), { messageBytes: 36 * MB });
	assert.deepEqual(
		segments.map((segment) => segment.fetch),
		[["1"], ["2"]],
	);
});

test("cancelled sign-ins are not failures, but are limited per server and per user", () => {
	const server = signInServerKey("a.example.com", 993);
	const cancelled = (count, at = server) =>
		Array.from({ length: count }, (_, index) => ({ at: NOW - 100_000 + index * 1000, server: at, aborted: true }));
	// The attempt being checked may still be cancelled, so 8 marked ones at a server leave no room: 8 in all.
	assert.deepEqual(evaluateSignInAttempts(cancelled(7), server, NOW), { allowed: true });
	const verdict = evaluateSignInAttempts(cancelled(8), server, NOW);
	assert.equal(verdict.allowed, false);
	assert.equal(verdict.reason, "cancels");
	assert.equal(verdict.retryAfterSeconds, 500);
	// Another server is its own count; the user as a whole stops at 15 cancelled attempts.
	assert.deepEqual(evaluateSignInAttempts(cancelled(8), "b.example.com:993", NOW), { allowed: true });
	const spread = Array.from({ length: 15 }, (_, index) => ({
		at: NOW - 100_000 + index * 1000,
		server: signInServerKey(`h${index}.example.com`, 993),
		aborted: true,
	}));
	assert.deepEqual(evaluateSignInAttempts(spread.slice(0, 14), "x.example.com:993", NOW), { allowed: true });
	assert.equal(evaluateSignInAttempts(spread, "x.example.com:993", NOW).reason, "cancels");
	// They do not count toward the failure limits, nor failures toward theirs.
	assert.deepEqual(evaluateSignInAttempts([...cancelled(7), ...attempts(5, server)], server, NOW), { allowed: true });
});

test("failures are reported as failures even when cancels are over their limit too", () => {
	const server = signInServerKey("a.example.com", 993);
	const rows = [
		...Array.from({ length: 9 }, (_, index) => ({ at: NOW - 100_000 + index, server, aborted: true })),
		...attempts(SIGN_IN_FAILURES_PER_SERVER + 1, server),
	];
	assert.equal(evaluateSignInAttempts(rows, server, NOW).reason, "failures");
});

test("being refused for cancelling never tells anyone to check the password", () => {
	assert.doesNotMatch(signInLimitMessage(120, "cancels"), /password|user name/i);
	assert.match(signInLimitMessage(120, "cancels"), /try again in 2 minutes/i);
	assert.match(signInLimitMessage(120, "failures"), /Check the user name and password/);
});

test("a server's refusal of the login is told from a cut connection", () => {
	assert.equal(isAuthRefusal(new Error("IMAP sign-in failed: A0002 NO [AUTHENTICATIONFAILED] bad")), true);
	assert.equal(isAuthRefusal(new Error("The connection was closed")), false);
	assert.equal(isAuthRefusal("sign-in failed"), false);
});

test("a skipped message is named with its folder, UID and size", () => {
	assert.equal(
		oversizedNote("INBOX", { uid: "42", size: 80 * MB }, 36 * MB),
		"INBOX: skipped message 42, 80 MB is over the 36 MB limit",
	);
});
