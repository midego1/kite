import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	quoteImapString,
	parseSearchUids,
	getLiteralLength,
	isTaggedCompletion,
	isTaggedOk,
	parseListMailboxName,
	parseFetchUid,
	parseCapabilities,
	parseGreeting,
	planStartTls,
	chooseAuthMethod,
	plainAuthToken,
	selectImapUidBatch,
	selectRemainingUids,
	chunk,
	imapSecurity,
} = await bundleModules("kite-imap-utils-", [
	[
		"quoteImapString, parseSearchUids, getLiteralLength, isTaggedCompletion, isTaggedOk, parseListMailboxName, parseFetchUid, parseCapabilities, parseGreeting, planStartTls, chooseAuthMethod, plainAuthToken",
		"src/lib/imap/protocol-utils.ts",
	],
	["selectImapUidBatch, selectRemainingUids, chunk, imapSecurity", "src/lib/import/imap-utils.ts"],
]);

test("quoteImapString escapes backslashes and quotes and refuses line breaks", () => {
	assert.equal(quoteImapString("plain"), '"plain"');
	assert.equal(quoteImapString('a"b'), '"a\\"b"');
	assert.equal(quoteImapString("a\\b"), '"a\\\\b"');
	for (const value of ["a\r\nA2 DELETE INBOX", "a\nb", "a\0b"])
		assert.throws(() => quoteImapString(value), /line breaks/, JSON.stringify(value));
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

test("isTaggedOk tells OK from NO and BAD", () => {
	assert.equal(isTaggedOk("A1 OK done", "A1"), true);
	assert.equal(isTaggedOk("a1 ok done", "A1"), true);
	assert.equal(isTaggedOk("A1 NO not OK", "A1"), false);
	assert.equal(isTaggedOk("A1 BAD OK?", "A1"), false);
});

test("parseCapabilities reads CAPABILITY responses and response codes", () => {
	assert.deepEqual(parseCapabilities("* CAPABILITY IMAP4rev1 STARTTLS auth=plain"), [
		"IMAP4REV1",
		"STARTTLS",
		"AUTH=PLAIN",
	]);
	assert.deepEqual(parseCapabilities("* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] ready"), [
		"IMAP4REV1",
		"SASL-IR",
		"AUTH=PLAIN",
	]);
	assert.deepEqual(parseCapabilities("A0003 OK [CAPABILITY IMAP4rev1 IDLE] Signed in"), ["IMAP4REV1", "IDLE"]);
	assert.equal(parseCapabilities("* OK ready"), null);
	assert.equal(parseCapabilities("* 3 EXISTS"), null);
});

test("parseGreeting tells OK, PREAUTH and anything else apart", () => {
	assert.equal(parseGreeting("* OK [CAPABILITY IMAP4rev1] ready"), "ok");
	assert.equal(parseGreeting("* ok ready"), "ok");
	assert.equal(parseGreeting("* PREAUTH welcome back"), "preauth");
	assert.equal(parseGreeting("* BYE too many connections"), null);
	assert.equal(parseGreeting("+OK POP3 ready"), null);
});

test("planStartTls upgrades, refuses or goes on as it must", () => {
	const plan = (input) =>
		planStartTls({ security: "starttls", capabilities: [], preauth: false, plainTextAllowed: false, ...input });
	assert.deepEqual(plan({ security: "tls" }), { action: "none" });
	assert.deepEqual(plan({ security: "tls", preauth: true }), { action: "none" });
	assert.deepEqual(plan({ capabilities: ["IMAP4REV1", "STARTTLS"] }), { action: "starttls" });
	assert.match(plan({ capabilities: ["IMAP4REV1"] }).reason, /does not offer STARTTLS.*port 993/);
	assert.equal(plan({ capabilities: ["IMAP4REV1"] }).action, "refuse");
	assert.match(plan({ capabilities: ["STARTTLS"], preauth: true }).reason, /before the connection was encrypted/);
	// The loopback fake under the dev flag: upgrade when offered, else go on in plain text.
	assert.deepEqual(plan({ capabilities: ["STARTTLS"], plainTextAllowed: true }), { action: "starttls" });
	assert.deepEqual(plan({ capabilities: ["IMAP4REV1"], plainTextAllowed: true }), { action: "none" });
	assert.deepEqual(plan({ capabilities: ["STARTTLS"], preauth: true, plainTextAllowed: true }), { action: "none" });
});

test("chooseAuthMethod prefers PLAIN, uses SASL-IR, and respects LOGINDISABLED", () => {
	assert.equal(chooseAuthMethod(["IMAP4REV1", "AUTH=PLAIN", "SASL-IR"]), "plain-ir");
	assert.equal(chooseAuthMethod(["IMAP4REV1", "AUTH=PLAIN"]), "plain");
	assert.equal(chooseAuthMethod(["IMAP4REV1", "AUTH=PLAIN", "LOGINDISABLED"]), "plain");
	assert.equal(chooseAuthMethod(["IMAP4REV1"]), "login");
	assert.equal(chooseAuthMethod(["IMAP4REV1", "AUTH=XOAUTH2", "LOGINDISABLED"]), null);
});

test("plainAuthToken encodes the RFC 4616 message as UTF-8", () => {
	assert.equal(plainAuthToken("user", "pass"), Buffer.from("\0user\0pass").toString("base64"));
	assert.equal(
		Buffer.from(plainAuthToken("jö@example.test", "pä ss"), "base64").toString("utf8"),
		"\0jö@example.test\0pä ss",
	);
});

test("imapSecurity maps the TLS switch to implicit TLS or STARTTLS, never plain text", () => {
	assert.equal(imapSecurity(true), "tls");
	assert.equal(imapSecurity(false), "starttls");
});
