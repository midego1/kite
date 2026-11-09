import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	advanceColdCursor,
	initialColdCursor,
	isStorageColdMessage,
	nextColdSource,
	parseColdCursor,
	R2_IA_TARGET,
	selectColdCandidates,
	STORAGE_COLD_KIND,
} = await bundleModules("kite-storage-cold-utils-", [
	[
		"advanceColdCursor, initialColdCursor, isStorageColdMessage, nextColdSource, parseColdCursor, R2_IA_TARGET, selectColdCandidates, STORAGE_COLD_KIND",
		"src/lib/storage/cold-utils.ts",
	],
]);

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-08T00:00:00Z");
const rule = { objectClass: "mail", afterDays: 30, minBytes: 1024, target: R2_IA_TARGET };
const cutoff = new Date(now.getTime() - rule.afterDays * DAY);

test("an object exactly at the age cutoff is eligible; one day younger is not", () => {
	const atCutoff = { size: 2048, createdAt: new Date(now.getTime() - 30 * DAY) };
	const younger = { size: 2048, createdAt: new Date(now.getTime() - 29 * DAY) };
	assert.deepEqual(selectColdCandidates(rule, cutoff, [atCutoff, younger]), [atCutoff]);
});

test("an object under the size floor is not eligible; one at or above it is", () => {
	const tooSmall = { size: 1023, createdAt: new Date(now.getTime() - 60 * DAY) };
	const atFloor = { size: 1024, createdAt: new Date(now.getTime() - 60 * DAY) };
	const bigger = { size: 4096, createdAt: new Date(now.getTime() - 60 * DAY) };
	assert.deepEqual(selectColdCandidates(rule, cutoff, [tooSmall, atFloor, bigger]), [atFloor, bigger]);
});

test("a null size (raw mail has none recorded) always passes the floor; age alone decides", () => {
	const old = { size: null, createdAt: new Date(now.getTime() - 60 * DAY) };
	const young = { size: null, createdAt: new Date(now.getTime() - 1 * DAY) };
	assert.deepEqual(selectColdCandidates(rule, cutoff, [old, young]), [old]);
});

test("a rule with no size floor (0) accepts every age-eligible size, including 0", () => {
	const zeroFloor = { ...rule, minBytes: 0 };
	const empty = { size: 0, createdAt: new Date(now.getTime() - 60 * DAY) };
	assert.deepEqual(selectColdCandidates(zeroFloor, cutoff, [empty]), [empty]);
});

test("the cursor resolves afterDays against the given moment, not the wall clock", () => {
	assert.equal(initialColdCursor(rule, now).cutoffAt, Math.floor(cutoff.getTime() / 1000));
	assert.equal(initialColdCursor({ ...rule, afterDays: 0 }, now).cutoffAt, Math.floor(now.getTime() / 1000));
});

test("the cursor walks mail's three sources in order and finishes once all are done", () => {
	let cursor = initialColdCursor(rule, now);
	assert.deepEqual(cursor.sources, { messages: null, attachments: null, bodies: null });
	assert.equal(nextColdSource(cursor), "messages");
	cursor = advanceColdCursor(cursor, "messages", "m5", true);
	assert.equal(nextColdSource(cursor), "attachments");
	cursor = advanceColdCursor(cursor, "attachments", "a1", false);
	assert.equal(cursor.sources.attachments, "a1");
	assert.equal(nextColdSource(cursor), "attachments", "not exhausted, so it is visited again next batch");
	cursor = advanceColdCursor(cursor, "attachments", "a9", true);
	assert.equal(nextColdSource(cursor), "bodies");
	cursor = advanceColdCursor(cursor, "bodies", null, true);
	assert.equal(nextColdSource(cursor), null);
});

test("drive's cursor has one source", () => {
	const driveRule = { objectClass: "drive", afterDays: 90, minBytes: 0, target: "sto_abc" };
	assert.deepEqual(initialColdCursor(driveRule, now).sources, { drive: null });
});

test("parseColdCursor round-trips a saved cursor and throws on anything else", () => {
	const cursor = initialColdCursor(rule, now);
	assert.deepEqual(parseColdCursor(JSON.stringify(cursor)), cursor);
	assert.throws(() => parseColdCursor(null));
	assert.throws(() => parseColdCursor("not json"));
	assert.throws(() => parseColdCursor(JSON.stringify({ rule })), "missing sources");
	assert.throws(() => parseColdCursor(JSON.stringify({ sources: {} })), "missing rule");
});

test("isStorageColdMessage accepts only its own shape", () => {
	assert.ok(isStorageColdMessage({ kind: STORAGE_COLD_KIND, objectClass: "mail" }));
	assert.ok(!isStorageColdMessage({ kind: "storage.migrate", objectClass: "mail" }));
	assert.ok(!isStorageColdMessage({ kind: STORAGE_COLD_KIND }));
	assert.ok(!isStorageColdMessage(null));
});
