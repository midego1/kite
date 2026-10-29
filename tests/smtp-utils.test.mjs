import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SMTP_PORTS,
	smtpLimits,
	parseReplyLine,
	buildReply,
	replyText,
	parseEhloExtensions,
	planSmtpStartTls,
	chooseSmtpAuthMethod,
	base64Utf8,
	smtpPlainToken,
	assertCredential,
	redactSecrets,
	transportAddress,
	smtpDataPayload,
	hasEightBitBytes,
	smtpFailureMessage,
	SmtpReplyError,
	SmtpMessageTooLargeError,
	SmtpDeliveryUnknownError,
} = await bundleModules("kite-smtp-utils-", [
	[
		"SMTP_PORTS, smtpLimits, parseReplyLine, buildReply, replyText, parseEhloExtensions, planSmtpStartTls, chooseSmtpAuthMethod, base64Utf8, smtpPlainToken, assertCredential, redactSecrets, transportAddress, smtpDataPayload, hasEightBitBytes, smtpFailureMessage",
		"src/lib/smtp/protocol-utils.ts",
	],
	["SmtpReplyError, SmtpMessageTooLargeError, SmtpDeliveryUnknownError", "src/lib/smtp/errors.ts"],
]);

const reply = (code, ...lines) => buildReply(lines.map((text) => ({ code, text })));
const bytes = (text) => new TextEncoder().encode(text);
const text = (data) => new TextDecoder().decode(data);

test("submission ports and limits", () => {
	assert.deepEqual([...SMTP_PORTS], [465, 587]);
	assert.deepEqual(smtpLimits(), {
		lineBytes: 16 * 1024,
		replyLines: 1000,
		commandTimeoutMs: 120_000,
		dataTimeoutMs: 600_000,
	});
});

test("parseReplyLine reads the code, whether the reply goes on, and the text", () => {
	assert.deepEqual(parseReplyLine("250-smtp.example.com at your service"), {
		code: 250,
		final: false,
		text: "smtp.example.com at your service",
	});
	assert.deepEqual(parseReplyLine("250 SIZE 35882577"), { code: 250, final: true, text: "SIZE 35882577" });
	assert.deepEqual(parseReplyLine("354"), { code: 354, final: true, text: "" });
	assert.deepEqual(parseReplyLine("535 "), { code: 535, final: true, text: "" });
	for (const line of ["", "OK", "25 short", "250x", "199 too low", "600 too high", "* OK imap", "HTTP/1.1 400"])
		assert.equal(parseReplyLine(line), null, line);
});

test("buildReply takes the last line's code and the first line's enhanced code", () => {
	assert.deepEqual(reply(535, "5.7.8 Username and Password not accepted. Learn more at", "5.7.8  https://x"), {
		code: 535,
		enhancedCode: "5.7.8",
		lines: ["5.7.8 Username and Password not accepted. Learn more at", "5.7.8  https://x"],
	});
	assert.equal(reply(250, "2.1.0 OK").enhancedCode, "2.1.0");
	assert.equal(reply(250, "2.1.0").enhancedCode, "2.1.0");
	assert.equal(reply(250, "OK 2.1.0").enhancedCode, null);
	assert.equal(reply(550, "5.1.10x").enhancedCode, null);
	assert.deepEqual(buildReply([]), { code: 0, enhancedCode: null, lines: [] });
});

test("replyText joins the lines, collapses whitespace and cuts at 300 characters", () => {
	assert.equal(replyText(reply(451, "4.3.0  Try\tagain", "later")), "451 4.3.0 Try again later");
	const long = replyText(reply(550, "x".repeat(400)));
	assert.equal(long.length, 300);
	assert.ok(long.endsWith("…"));
});

test("parseEhloExtensions reads keywords, AUTH mechanisms (both spellings) and SIZE", () => {
	const extensions = parseEhloExtensions(
		reply(
			250,
			"smtp.gmail.com at your service, [203.0.113.7]",
			"SIZE 35882577",
			"8BITMIME",
			"STARTTLS",
			"ENHANCEDSTATUSCODES",
			"auth login plain XOAUTH2",
			"AUTH=LOGIN PLAIN-CLIENTTOKEN",
			"PIPELINING",
			"pipelining",
			"",
		),
	);
	assert.deepEqual(extensions, {
		keywords: ["SIZE", "8BITMIME", "STARTTLS", "ENHANCEDSTATUSCODES", "AUTH", "PIPELINING"],
		auth: ["LOGIN", "PLAIN", "XOAUTH2", "PLAIN-CLIENTTOKEN"],
		size: 35882577,
	});
	assert.equal(parseEhloExtensions(reply(250, "name", "SIZE 0")).size, null);
	assert.equal(parseEhloExtensions(reply(250, "name", "SIZE")).size, null);
	assert.equal(parseEhloExtensions(reply(250, "name", "SIZE lots")).size, null);
	assert.deepEqual(parseEhloExtensions(reply(250, "only the name")), { keywords: [], auth: [], size: null });
});

test("planSmtpStartTls never lets a password go over plain text, except to the dev loopback fake", () => {
	const extensions = (keywords) => ({ keywords, auth: ["PLAIN"], size: null });
	const plan = (security, keywords, plainTextAllowed = false) =>
		planSmtpStartTls({ security, extensions: extensions(keywords), plainTextAllowed });
	assert.deepEqual(plan("tls", []), { action: "none" });
	assert.deepEqual(plan("starttls", ["STARTTLS"]), { action: "starttls" });
	assert.deepEqual(plan("starttls", ["STARTTLS"], true), { action: "starttls" });
	assert.deepEqual(plan("starttls", [], true), { action: "none" });
	const refused = plan("starttls", ["AUTH"]);
	assert.equal(refused.action, "refuse");
	assert.match(refused.reason, /does not offer STARTTLS.*Use port 465 with TLS instead/);
});

test("chooseSmtpAuthMethod prefers PLAIN, falls back to LOGIN, and refuses anything else", () => {
	assert.equal(chooseSmtpAuthMethod(["LOGIN", "PLAIN"]), "plain");
	assert.equal(chooseSmtpAuthMethod(["LOGIN", "XOAUTH2"]), "login");
	assert.equal(chooseSmtpAuthMethod(["XOAUTH2", "CRAM-MD5"]), null);
	assert.equal(chooseSmtpAuthMethod([]), null);
});

test("SASL tokens are UTF-8 base64, and values that could break the exchange are refused", () => {
	assert.equal(base64Utf8("ü"), "w7w=");
	assert.equal(
		Buffer.from(smtpPlainToken("user@example.test", "pässword"), "base64").toString(),
		"\0user@example.test\0pässword",
	);
	for (const [user, password] of [
		["a\0b", "p"],
		["a", "p\0"],
		["a", "p\r\nRSET"],
		["a\n", "p"],
	]) {
		assert.throws(() => smtpPlainToken(user, password), /cannot contain NUL or line break/);
		assert.throws(
			() => assertCredential(user, password),
			(error) => !error.message.includes("p\r\n"),
		);
	}
});

test("redactSecrets removes secrets and their base64 form, but not short values", () => {
	const secret = "app-password";
	assert.equal(
		redactSecrets(`bad ${secret} ${Buffer.from(secret).toString("base64")} ok`, [secret, "ab"]),
		"bad [redacted] [redacted] ok",
	);
	assert.equal(redactSecrets("ab is fine", ["ab"]), "ab is fine");
});

test("transportAddress accepts bare and named addresses and turns IDN domains into punycode", () => {
	assert.equal(transportAddress(" user@example.test "), "user@example.test");
	assert.equal(transportAddress('"Doe, John" <john.doe+tag@Example.ORG>'), "john.doe+tag@example.org");
	assert.equal(transportAddress("info@Bücher.example"), "info@xn--bcher-kva.example");
	assert.equal(transportAddress("o'brien@sub.example.co.uk"), "o'brien@sub.example.co.uk");
});

test("transportAddress refuses what could break a command or needs SMTPUTF8", () => {
	for (const value of [
		"",
		"no-at-sign",
		"@example.org",
		"user@",
		"a b@example.org",
		"jörg@example.org",
		'"quoted local"@example.org',
		"a@example.org>\r\nRSET",
		"a<b@example.org",
		".lead@example.org",
		"trail.@example.org",
		"dou..ble@example.org",
		"user@localhost",
		"user@[127.0.0.1]",
		"user@exa mple.org",
		"user@example..org",
		"user@-",
		`${"a".repeat(65)}@example.org`,
		`user@${"a".repeat(64)}.example.org`,
	])
		assert.throws(() => transportAddress(value), /not an address mail can be sent to/, JSON.stringify(value));
	// A list is never read as its last address.
	for (const value of ["A <a@x.com>, B <b@y.com>", "<a@x.com><b@y.com>", "a@x.com>>"])
		assert.throws(() => transportAddress(value), /is more than one address/, value);
	assert.throws(() => transportAddress("a@x.com, b@y.com"), /not an address mail can be sent to/);
	assert.throws(
		() => transportAddress(`${"a".repeat(60)}@${Array(5).fill("b".repeat(60)).join(".")}.org`),
		/longer than mail servers accept/,
	);
	// Control characters never reach the error message.
	assert.throws(
		() => transportAddress("bad\u0007address"),
		(error) => !error.message.includes("\u0007"),
	);
	assert.throws(
		() => transportAddress(`${"x".repeat(100)} bad`),
		(error) => error.message.includes("…"),
	);
});

test("smtpDataPayload makes every line ending CRLF, doubles leading dots and ends with the marker", () => {
	assert.equal(text(smtpDataPayload(bytes("a\r\nb\r\n"))), "a\r\nb\r\n.\r\n");
	assert.equal(text(smtpDataPayload(bytes("no final break"))), "no final break\r\n.\r\n");
	assert.equal(text(smtpDataPayload(bytes(""))), ".\r\n");
	assert.equal(text(smtpDataPayload(bytes(".\r\n..\r\n.x\r\na.b\r\n"))), "..\r\n...\r\n..x\r\na.b\r\n.\r\n");
	assert.equal(text(smtpDataPayload(bytes(".starts"))), "..starts\r\n.\r\n");
	// Bare LF and bare CR become CRLF, so `\n.\n` or `\r.\r` can never end the data early.
	assert.equal(text(smtpDataPayload(bytes("a\n.\nb\r.\rc"))), "a\r\n..\r\nb\r\n..\r\nc\r\n.\r\n");
	assert.equal(text(smtpDataPayload(bytes("x\r\r\ny"))), "x\r\n\r\ny\r\n.\r\n");
	const utf8 = bytes("ü\r\n");
	assert.deepEqual([...smtpDataPayload(utf8)], [...utf8, 46, 13, 10]);
});

test("hasEightBitBytes", () => {
	assert.equal(hasEightBitBytes(bytes("plain ascii\r\n")), false);
	assert.equal(hasEightBitBytes(bytes("café")), true);
});

test("smtpFailureMessage names the stage, and the recipient a RCPT failed for", () => {
	const refused = reply(550, "5.1.1 No such user");
	assert.equal(
		smtpFailureMessage("rcpt", refused, "nobody@example.org"),
		"The SMTP server refused the recipient nobody@example.org: 550 5.1.1 No such user",
	);
	assert.equal(smtpFailureMessage("rcpt", refused), "The SMTP server refused a recipient: 550 5.1.1 No such user");
	assert.equal(
		smtpFailureMessage("greeting", reply(554, "go away")),
		"The SMTP server refused the connection: 554 go away",
	);
	for (const stage of ["ehlo", "starttls", "auth", "mail", "data"])
		assert.match(smtpFailureMessage(stage, refused), /: 550 5\.1\.1 No such user$/);
});

test("SmtpReplyError tells temporary failures and broken credentials apart", () => {
	const auth = new SmtpReplyError("auth", reply(535, "5.7.8 Bad credentials"));
	assert.equal(auth.name, "SmtpReplyError");
	assert.equal(auth.stage, "auth");
	assert.equal(auth.code, 535);
	assert.equal(auth.enhancedCode, "5.7.8");
	assert.equal(auth.authFailed, true);
	assert.equal(auth.temporary, false);
	assert.equal(new SmtpReplyError("auth", reply(534, "5.7.8 Use an app password")).authFailed, true);
	assert.equal(new SmtpReplyError("auth", reply(454, "4.7.0 Try later")).authFailed, false);
	assert.equal(new SmtpReplyError("auth", reply(454, "4.7.0 Try later")).temporary, true);
	assert.equal(new SmtpReplyError("data", reply(535, "odd")).authFailed, false);
	const rcpt = new SmtpReplyError("rcpt", reply(452, "4.5.3 Too many recipients"), "x@example.org");
	assert.equal(rcpt.temporary, true);
	assert.match(rcpt.message, /recipient x@example\.org/);
});

test("SmtpMessageTooLargeError names both sizes in MB", () => {
	const error = new SmtpMessageTooLargeError(30 * 1024 * 1024, 25 * 1024 * 1024);
	assert.equal(error.name, "SmtpMessageTooLargeError");
	assert.equal(error.limitBytes, 25 * 1024 * 1024);
	assert.equal(error.message, "The message is 30 MB; the SMTP server accepts at most 25 MB");
});

test("SmtpDeliveryUnknownError is never temporary or retryable; SmtpReplyError retries only 4xx", () => {
	const unknown = new SmtpDeliveryUnknownError("SMTP connection closed unexpectedly");
	assert.equal(unknown.name, "SmtpDeliveryUnknownError");
	assert.equal(unknown.temporary, false);
	assert.equal(unknown.retryable, false);
	assert.match(unknown.message, /may have been delivered: SMTP connection closed unexpectedly$/);
	assert.equal(new SmtpReplyError("data", reply(451, "later")).retryable, true);
	assert.equal(new SmtpReplyError("data", reply(554, "no")).retryable, false);
});
