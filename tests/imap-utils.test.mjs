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
	imapLoginArgument,
	imapLimits,
	parseFetchAttributes,
	parseInternalDate,
	selectImapUidBatch,
	selectRemainingUids,
	chunk,
	imapSecurity,
	importFlagState,
	importMessageFromImap,
	hostImportMessageFromImap,
} = await bundleModules("kite-imap-utils-", [
	[
		"quoteImapString, parseSearchUids, getLiteralLength, isTaggedCompletion, isTaggedOk, parseListMailboxName, parseFetchUid, parseCapabilities, parseGreeting, planStartTls, chooseAuthMethod, plainAuthToken, imapLoginArgument, imapLimits, parseFetchAttributes, parseInternalDate",
		"src/lib/imap/protocol-utils.ts",
	],
	[
		"selectImapUidBatch, selectRemainingUids, chunk, imapSecurity, importFlagState, importMessageFromImap, hostImportMessageFromImap",
		"src/lib/import/imap-utils.ts",
	],
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

test("plainAuthToken refuses a NUL that would shift the PLAIN fields", () => {
	assert.throws(() => plainAuthToken("a\0b", "pass"), /NUL/);
	assert.throws(() => plainAuthToken("user", "pa\0ss"), /NUL/);
});

test("imapLoginArgument quotes printable ASCII and turns anything else into a literal", () => {
	assert.deepEqual(imapLoginArgument('pa"ss'), { kind: "quoted", text: '"pa\\"ss"' });
	const literal = imapLoginArgument("pässword");
	assert.equal(literal.kind, "literal");
	assert.equal(new TextDecoder().decode(literal.bytes), "pässword");
	assert.equal(literal.bytes.byteLength, 9);
	assert.equal(imapLoginArgument("line\r\nbreak").kind, "literal");
	assert.throws(() => imapLoginArgument("a\0b"), /NUL/);
});

test("imapLimits keeps Workers inside an isolate's memory and gives the Node server more room", () => {
	const MB = 1024 * 1024;
	const workers = imapLimits(undefined);
	const node = imapLimits("node");
	assert.equal(workers.literalBytes, 36 * MB);
	assert.equal(workers.fetchBatchBytes, 48 * MB);
	assert.equal(node.literalBytes, 64 * MB);
	assert.equal(node.fetchBatchBytes, 96 * MB);
	// A message at Gmail's 25 MB attachment limit, base64 encoded with headers, fits on Workers.
	assert.ok(workers.literalBytes > Math.ceil((25 * MB * 4) / 3) + 512 * 1024);
	for (const limits of [workers, node]) {
		assert.ok(limits.literalBytes <= limits.fetchBatchBytes);
		assert.equal(limits.lineBytes, 8 * MB);
		assert.equal(limits.commandResponseBytes, 32 * MB);
		assert.equal(limits.commandResponseLines, 200_000);
		assert.equal(limits.commandTimeoutMs, 180_000);
		assert.equal(limits.commandMaxMs, 600_000);
		// 96 MB at 4 Mbit/s (500 KB/s) takes about 197 s: more than the base timeout, inside what it earns and the cap.
		const seconds = (96 * MB) / 500_000;
		const allowed = Math.min(
			limits.commandTimeoutMs / 1000 + (96 * MB) / limits.minBytesPerSecond,
			limits.commandMaxMs / 1000,
		);
		assert.ok(seconds > limits.commandTimeoutMs / 1000 && seconds < allowed);
	}
});

test("parseInternalDate reads IMAP date-times with their zone, and nothing else", () => {
	assert.equal(parseInternalDate("17-Jul-1996 02:44:25 -0700").toISOString(), "1996-07-17T09:44:25.000Z");
	assert.equal(parseInternalDate(" 7-Jan-2026 23:00:00 +0100").toISOString(), "2026-01-07T22:00:00.000Z");
	assert.equal(parseInternalDate("07-jan-2026 00:00:00 +0000").toISOString(), "2026-01-07T00:00:00.000Z");
	for (const value of [
		"31-Feb-2026 10:00:00 +0000",
		"01-Foo-2026 10:00:00 +0000",
		"01-Jan-2026 25:00:00 +0000",
		"2026-01-01T00:00:00Z",
		"",
	])
		assert.equal(parseInternalDate(value), null, value);
});

test("parseFetchAttributes reads UID, FLAGS, INTERNALDATE and RFC822.SIZE in any order", () => {
	assert.deepEqual(
		parseFetchAttributes(
			'* 1 FETCH (UID 10 FLAGS (\\Seen \\Flagged $Forwarded) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 4286 BODY[] {4286} )',
		),
		{
			uid: "10",
			flags: ["\\Seen", "\\Flagged", "$Forwarded"],
			internalDate: new Date("1996-07-17T09:44:25Z"),
			size: 4286,
		},
	);
	assert.deepEqual(parseFetchAttributes("* 2 FETCH (BODY[] {5}  UID 11 RFC822.SIZE 5 FLAGS ())"), {
		uid: "11",
		flags: [],
		internalDate: null,
		size: 5,
	});
	assert.deepEqual(parseFetchAttributes('* 3 FETCH (UID 12 BODY[] {5} INTERNALDATE "not a date")'), {
		uid: "12",
		flags: [],
		internalDate: null,
		size: null,
	});
});

test("importFlagState keeps \\Seen as read and \\Flagged as starred, whatever the case", () => {
	assert.deepEqual(importFlagState(["\\Seen", "\\Flagged"]), { read: true, starred: true });
	assert.deepEqual(importFlagState(["\\SEEN"]), { read: true, starred: false });
	assert.deepEqual(importFlagState(["\\flagged", "\\Answered", "$Important"]), { read: false, starred: true });
	assert.deepEqual(importFlagState(["Seen", "\\Draft", "\\Recent"]), { read: false, starred: false });
	assert.deepEqual(importFlagState([]), { read: false, starred: false });
});

test("IMAP messages carry their state into the direct and the background import", () => {
	const raw = new TextEncoder().encode("Subject: x\r\n\r\nbody").buffer;
	const internalDate = new Date("2026-10-27T10:00:00Z");
	const fetched = { raw, flags: ["\\Seen"], internalDate, size: 18 };
	assert.deepEqual(importMessageFromImap("INBOX-1.eml", fetched), {
		filename: "INBOX-1.eml",
		raw,
		read: true,
		starred: false,
		receivedAt: internalDate,
	});
	assert.deepEqual(
		hostImportMessageFromImap("INBOX-1.eml", fetched, () => "b64"),
		{
			filename: "INBOX-1.eml",
			raw: "b64",
			encoding: "base64",
			read: true,
			starred: false,
			receivedAt: "2026-10-27T10:00:00.000Z",
		},
	);
	const undated = hostImportMessageFromImap(
		"x.eml",
		{ ...fetched, flags: ["\\Flagged"], internalDate: null },
		() => "b",
	);
	assert.equal("receivedAt" in undated, false);
	assert.equal(undated.starred, true);
});
