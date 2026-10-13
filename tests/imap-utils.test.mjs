import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	quoteImapString,
	parseSearchUids,
	selectImapUidBatch,
	getLiteralLength,
	isTaggedCompletion,
	parseListMailboxName,
	assertSafeImapHost,
	parseFetchUid,
	selectRemainingUids,
	chunk,
} = await bundleModules("kite-imap-utils-", [
	[
		"quoteImapString, parseSearchUids, selectImapUidBatch, getLiteralLength, isTaggedCompletion, parseListMailboxName, assertSafeImapHost, parseFetchUid, selectRemainingUids, chunk",
		"src/lib/import/imap-utils.ts",
	],
]);

test("quoteImapString escapes backslashes and quotes", () => {
	assert.equal(quoteImapString("plain"), '"plain"');
	assert.equal(quoteImapString('a"b'), '"a\\"b"');
	assert.equal(quoteImapString("a\\b"), '"a\\\\b"');
});

test("parseSearchUids reads the numbers of a SEARCH line and ignores anything else", () => {
	assert.deepEqual(parseSearchUids("* SEARCH 4 9 12"), ["4", "9", "12"]);
	assert.deepEqual(parseSearchUids("* search 7"), ["7"]);
	assert.deepEqual(parseSearchUids("* SEARCH"), []);
	assert.deepEqual(parseSearchUids("* SEARCH 4 x 5"), ["4", "5"]);
	assert.deepEqual(parseSearchUids("A1 OK done"), []);
});

test("selectImapUidBatch walks back from the newest messages and reports the next offset", () => {
	const all = ["1", "2", "3", "4", "5"];
	assert.deepEqual(selectImapUidBatch(all, 2, 0), { uids: ["4", "5"], total: 5, nextOffset: 2 });
	assert.deepEqual(selectImapUidBatch(all, 2, 2), { uids: ["2", "3"], total: 5, nextOffset: 4 });
	assert.deepEqual(selectImapUidBatch(all, 2, 4), { uids: ["1"], total: 5, nextOffset: null });
	assert.deepEqual(selectImapUidBatch(all, 10, 0), { uids: all, total: 5, nextOffset: null });
	assert.deepEqual(selectImapUidBatch(all, 0, -3), { uids: ["5"], total: 5, nextOffset: 1 });
});

test("getLiteralLength reads a trailing literal size", () => {
	assert.equal(getLiteralLength("* 1 FETCH (BODY[] {342}"), 342);
	assert.equal(getLiteralLength("* 1 FETCH (UID 4)"), null);
});

test("isTaggedCompletion matches the command tag case-insensitively", () => {
	assert.equal(isTaggedCompletion("a1 OK done", "A1"), true);
	assert.equal(isTaggedCompletion("A10 OK done", "A1"), false);
	assert.equal(isTaggedCompletion("* OK hello", "A1"), false);
});

test("parseListMailboxName reads quoted, escaped and bare names", () => {
	assert.equal(parseListMailboxName('* LIST (\\HasNoChildren) "/" "INBOX"'), "INBOX");
	assert.equal(parseListMailboxName('* LIST (\\HasNoChildren) "/" "Sent \\"Items\\""'), 'Sent "Items"');
	assert.equal(parseListMailboxName("* LIST () NIL Archive"), "Archive");
	assert.equal(parseListMailboxName("* LIST ()"), null);
	assert.equal(parseListMailboxName("* OK"), null);
});

test("assertSafeImapHost refuses private and local hosts and accepts public names", () => {
	for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.9", "intranet", ""])
		assert.throws(() => assertSafeImapHost(host), /Private and local IMAP hosts are not allowed/, host);
	assert.doesNotThrow(() => assertSafeImapHost("imap.example.com"));
});

test("parseFetchUid finds the UID in a FETCH line", () => {
	assert.equal(parseFetchUid("* 3 FETCH (UID 1234 BODY[] {5}"), "1234");
	assert.equal(parseFetchUid("* 3 FETCH (FLAGS ())"), null);
});

test("selectRemainingUids keeps UIDs below the cursor, newest first, and drops junk", () => {
	assert.deepEqual(selectRemainingUids(["3", "9", "5"], null), [9, 5, 3]);
	assert.deepEqual(selectRemainingUids(["3", "9", "5"], 5), [3]);
	assert.deepEqual(selectRemainingUids(["0", "-2", "x", "7"], null), [7]);
});

test("chunk splits a list into pieces of at most the size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 3), []);
});
