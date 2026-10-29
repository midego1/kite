import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The pure rules of send-as (spec §7): when an account's address may be sent as, how a failed submission is sorted
// (only a 4xx retries; delivery unknown never does), the envelope, the size estimate, the Sent folder, and the
// composer's From choices.

const {
	sendBlock,
	listsIdentity,
	SEND_BLOCK_TEXT,
	sameAddress,
	classifySubmitFailure,
	DELIVERY_UNKNOWN_MESSAGE,
	MAX_SUBMIT_ATTEMPTS,
	submitRetryDelaySeconds,
	appendRetryDelaySeconds,
	submissionEnvelope,
	sentRawKey,
	estimateMimeBytes,
	formatMegabytes,
	tooLargeMessage,
	assertWithinProviderLimit,
	pickSentFolder,
	isAppendSentMessage,
	SmtpReplyError,
	SmtpDeliveryUnknownError,
	SmtpMessageTooLargeError,
	buildReply,
	findPreset,
	EXTERNAL_ACCOUNT_PRESETS,
	mailboxOwnAddresses,
	mailboxSendableAddresses,
	senderOptionsFor,
	senderOptionLabel,
	sentToastMessage,
	sendEmailSchema,
} = await bundleModules("kite-send-as-utils-", [
	["sendBlock, listsIdentity, SEND_BLOCK_TEXT, sameAddress", "src/lib/external-accounts/identity-utils.ts"],
	[
		"classifySubmitFailure, DELIVERY_UNKNOWN_MESSAGE, MAX_SUBMIT_ATTEMPTS, submitRetryDelaySeconds, appendRetryDelaySeconds, submissionEnvelope, sentRawKey, estimateMimeBytes, formatMegabytes, tooLargeMessage, assertWithinProviderLimit, pickSentFolder, isAppendSentMessage",
		"src/lib/external-accounts/submit-utils.ts",
	],
	["SmtpReplyError, SmtpDeliveryUnknownError, SmtpMessageTooLargeError", "src/lib/smtp/errors.ts"],
	["buildReply", "src/lib/smtp/protocol-utils.ts"],
	["findPreset, EXTERNAL_ACCOUNT_PRESETS", "src/lib/external-accounts/presets-utils.ts"],
	[
		"mailboxOwnAddresses, mailboxSendableAddresses, senderOptionsFor, senderOptionLabel, sentToastMessage",
		"src/components/compose/sender-options-utils.ts",
	],
	["sendEmailSchema", "src/lib/validators.ts"],
]);

const reply = (code, text) => buildReply([{ code, text }]);

const account = (overrides = {}) => ({
	address: "me@gmail.com",
	username: "me@gmail.com",
	status: "active",
	smtpHost: "smtp.gmail.com",
	sendEnabled: true,
	hasPassword: true,
	smtpVerifiedAt: new Date(1),
	...overrides,
});

test("an address may be sent as only when it signs in, sending is on, it works and nothing refuses the owner", () => {
	assert.equal(sendBlock(account(), null), null);
	assert.equal(sendBlock(account({ username: "ME@Gmail.com " }), null), null);
	assert.equal(sendBlock(account(), "install_off"), "not_allowed");
	assert.equal(sendBlock(account(), "not_permitted"), "not_allowed");
	assert.equal(sendBlock(account({ smtpHost: null }), null), "no_smtp");
	assert.equal(sendBlock(account({ sendEnabled: false }), null), "send_off");
	assert.equal(sendBlock(account({ username: "me" }), null), "alias");
	for (const status of ["auth_failed", "tls_failed", "disabled"])
		assert.equal(sendBlock(account({ status }), null), "reconnect", status);
	assert.equal(sendBlock(account({ hasPassword: false }), null), "reconnect");
	assert.equal(sendBlock(account({ status: "paused" }), null), "paused");
	// A sync error does not stop sending; a missing SMTP test does.
	assert.equal(sendBlock(account({ status: "error" }), null), null);
	assert.equal(sendBlock(account({ smtpVerifiedAt: null }), null), "not_verified");
	assert.deepEqual(
		["not_allowed", "no_smtp", "send_off", "alias", "reconnect", "paused", "not_verified", null].filter(listsIdentity),
		["reconnect", "not_verified", null],
	);
	for (const text of Object.values(SEND_BLOCK_TEXT)) assert.ok(text.endsWith("."), text);
	assert.equal(sameAddress(" A@x.com", "a@X.com "), true);
	assert.equal(sameAddress("a@x.com", "b@x.com"), false);
});

test("only a 4xx is tried again, and only while attempts remain; delivery unknown never is", () => {
	const temporary = new SmtpReplyError("data", reply(451, "4.3.0 Try again later"));
	assert.equal(MAX_SUBMIT_ATTEMPTS, 3);
	assert.deepEqual(classifySubmitFailure(temporary, 1), {
		action: "retry",
		message: temporary.message,
		authFailed: false,
		deliveryUnknown: false,
	});
	assert.equal(classifySubmitFailure(temporary, 2).action, "retry");
	assert.equal(classifySubmitFailure(temporary, 3).action, "fail");

	const permanent = classifySubmitFailure(new SmtpReplyError("rcpt", reply(550, "5.1.1 No such user"), "x@y.org"), 1);
	assert.equal(permanent.action, "fail");
	assert.match(permanent.message, /refused the recipient x@y\.org: 550 5\.1\.1 No such user/);

	const unknown = classifySubmitFailure(new SmtpDeliveryUnknownError("reset"), 1);
	assert.deepEqual(unknown, {
		action: "fail",
		message: DELIVERY_UNKNOWN_MESSAGE,
		authFailed: false,
		deliveryUnknown: true,
	});

	for (const auth of [reply(535, "5.7.8 Bad credentials"), reply(534, "5.7.8 Use an app password")]) {
		const failure = classifySubmitFailure(new SmtpReplyError("auth", auth), 1);
		assert.equal(failure.action, "fail");
		assert.equal(failure.authFailed, true);
		assert.match(failure.message, /^SMTP sign-in failed: .*Reconnect the account/);
	}
	// A temporary sign-in problem is tried again and leaves the account alone.
	const busy = classifySubmitFailure(new SmtpReplyError("auth", reply(454, "4.7.0 Try later")), 1);
	assert.deepEqual([busy.action, busy.authFailed], ["retry", false]);

	assert.equal(classifySubmitFailure(new SmtpMessageTooLargeError(200, 100), 1).action, "fail");
	const network = classifySubmitFailure(new Error(`connect ECONNREFUSED ${"x".repeat(400)}`), 1);
	assert.deepEqual([network.action, network.message.length], ["fail", 300]);
	assert.equal(classifySubmitFailure("odd", 1).message, "Sending through the account failed");
	assert.deepEqual(
		[submitRetryDelaySeconds(1), submitRetryDelaySeconds(2), submitRetryDelaySeconds(5)],
		[60, 300, 300],
	);
	assert.deepEqual([appendRetryDelaySeconds(1), appendRetryDelaySeconds(2)], [60, 600]);
});

test("the envelope has every To, Cc and Bcc address; the raw is kept under sent/", () => {
	assert.deepEqual(
		submissionEnvelope({
			from: '"Me" <me@gmail.com>',
			to: ["A <a@x.org>, b@x.org"],
			cc: ["c@x.org"],
			bcc: ["Hidden <d@x.org>"],
		}),
		{ from: "me@gmail.com", recipients: ["a@x.org", "b@x.org", "c@x.org", "d@x.org"] },
	);
	assert.deepEqual(submissionEnvelope({ from: "me@gmail.com", to: ["a@x.org"] }).recipients, ["a@x.org"]);
	assert.equal(sentRawKey("msg_1"), "sent/msg_1.eml");
});

test("the size estimate stays above the real encoded size and names the provider's limit", () => {
	assert.equal(estimateMimeBytes({}), 16 * 1024);
	const withFile = estimateMimeBytes({ text: "é".repeat(100) }, [3_000_000]);
	assert.ok(withFile > 4_000_000 && withFile < 4_200_000, String(withFile));
	assert.equal(formatMegabytes(25_000_000), "25 MB");
	assert.equal(formatMegabytes(21_950_000), "22 MB");
	assert.equal(
		tooLargeMessage(30_000_000, 25_000_000, "Gmail"),
		"The message is about 30 MB; Gmail accepts at most 25 MB",
	);
	assert.doesNotThrow(() => assertWithinProviderLimit(null, {}, [{ content: { byteLength: 1e9 } }]));
	assert.doesNotThrow(() => assertWithinProviderLimit({ bytes: 25_000_000, provider: "Gmail" }, { text: "hi" }));
	assert.throws(
		() =>
			assertWithinProviderLimit({ bytes: 25_000_000, provider: "Gmail" }, {}, [
				{ content: new ArrayBuffer(19_000_000) },
			]),
		/Gmail accepts at most 25 MB/,
	);
	// Every preset but "Other" names a limit; Gmail's is 25 MB including encoding (spec §7.3).
	assert.equal(findPreset("gmail").maxMessageBytes, 25_000_000);
	assert.equal(findPreset("other").maxMessageBytes, null);
	for (const preset of EXTERNAL_ACCOUNT_PRESETS.filter((entry) => entry.id !== "other"))
		assert.ok(preset.maxMessageBytes >= 20_000_000, preset.id);
});

test("the Sent folder is the one marked \\Sent, else a usual name that can be selected", () => {
	const list = (...entries) => entries.map(([name, attributes = []]) => ({ name, delimiter: "/", attributes }));
	assert.equal(pickSentFolder(list(["INBOX"], ["Gesendet", ["\\Sent"]], ["Sent"])), "Gesendet");
	assert.equal(pickSentFolder(list(["INBOX"], ["[Gmail]/Sent Mail"])), "[Gmail]/Sent Mail");
	assert.equal(pickSentFolder(list(["INBOX.Sent"])), "INBOX.Sent");
	assert.equal(pickSentFolder(list(["Sent", ["\\Noselect"]], ["Sent Items"])), "Sent Items");
	assert.equal(pickSentFolder(list(["INBOX"], ["Archive"])), null);
});

test("Sent copy queue messages are recognised by kind and ids", () => {
	assert.equal(isAppendSentMessage({ kind: "accounts.append_sent", accountId: "a", messageId: "m" }), true);
	assert.equal(isAppendSentMessage({ kind: "accounts.append_sent", accountId: "a" }), false);
	assert.equal(isAppendSentMessage({ kind: "email.scheduled", accountId: "a", messageId: "m" }), false);
	assert.equal(isAppendSentMessage(null), false);
	assert.equal(isAppendSentMessage("accounts.append_sent"), false);
});

test("the From menu lists each mailbox's own addresses, then its connected ones; only available ones count", () => {
	const identity = (address, overrides = {}) => ({
		accountId: `acct-${address}`,
		address,
		displayName: null,
		presetLabel: "Gmail",
		available: true,
		action: null,
		hint: null,
		...overrides,
	});
	const kite = {
		id: "m1",
		localPart: "me",
		hostname: "kite.test",
		senderAddresses: ["me@kite.test", "me@alias.test"],
		externalIdentities: [
			identity("me@gmail.com"),
			identity("old@gmail.com", { available: false, action: "reconnect", hint: "Reconnect" }),
			// Never listed twice, even if it were also a domain address.
			identity("me@kite.test"),
		],
	};
	const bare = { id: "m2", localPart: "team", hostname: "kite.test" };
	assert.deepEqual(mailboxOwnAddresses(bare), ["team@kite.test"]);
	assert.deepEqual(mailboxSendableAddresses(kite), ["me@kite.test", "me@alias.test", "me@gmail.com"]);
	assert.deepEqual(mailboxSendableAddresses(bare), ["team@kite.test"]);
	const options = senderOptionsFor([kite, bare]);
	assert.deepEqual(
		options.map((option) => [option.mailbox.id, option.address, option.disabled, senderOptionLabel(option)]),
		[
			["m1", "me@kite.test", false, "me@kite.test"],
			["m1", "me@alias.test", false, "me@alias.test"],
			["m1", "me@gmail.com", false, "me@gmail.com (via Gmail)"],
			["m1", "old@gmail.com", true, "old@gmail.com (Reconnect in Settings)"],
			["m2", "team@kite.test", false, "team@kite.test"],
		],
	);
	assert.equal(
		senderOptionLabel({ address: "x@y.com", identity: identity("x@y.com", { action: "test_connection" }) }),
		"x@y.com (Test the connection in Settings)",
	);
});

test("a request body cannot switch on connected accounts: the send schema drops the flag", () => {
	const parsed = sendEmailSchema.parse({
		from: "me@gmail.com",
		to: ["a@x.org"],
		subject: "Hi",
		text: "Hi",
		mailboxId: "m1",
		connectedAccounts: true,
		externalAccountId: "xacct_1",
	});
	assert.equal("connectedAccounts" in parsed, false);
	assert.equal("externalAccountId" in parsed, false);
	assert.equal(sentToastMessage({}), "Message sent");
	assert.equal(sentToastMessage({ scheduled: true }), "Message scheduled");
	assert.match(sentToastMessage({ retrying: true }), /try again shortly/);
});
