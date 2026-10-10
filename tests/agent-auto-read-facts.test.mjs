import assert from "node:assert/strict";
import test from "node:test";
import {
	collectFacts,
	findSpoofedContact,
	isAutomaticMessage,
	isCalendarAttachment,
	needsModel,
} from "../src/lib/agent/auto-read/facts-utils.ts";

const signals = (...ids) => JSON.stringify(ids.map((id) => ({ id, score: 0, reason: id })));
const capabilities = { calendar: true, reply: true, summary: true, phishing: true, mutedSenders: [] };

function message(overrides = {}) {
	return {
		fromAddr: "Ada Lovelace <ada@example.com>",
		subject: "Question",
		textBody: "Could you send the report?",
		spamVerdict: "inbox",
		spamSignals: null,
		...overrides,
	};
}

test("isAutomaticMessage is exported and flags automatic senders and headers", () => {
	assert.equal(isAutomaticMessage("Mailer <MAILER-DAEMON@example.com>"), true);
	assert.equal(isAutomaticMessage("postmaster@example.com"), true);
	assert.equal(isAutomaticMessage("No Reply <no-reply@shop.test>"), true);
	assert.equal(isAutomaticMessage("noreply@shop.test"), true);
	assert.equal(isAutomaticMessage("do-not-reply@shop.test"), true);
	assert.equal(isAutomaticMessage("<donotreply@shop.test>"), true);
	assert.equal(isAutomaticMessage("ada@example.com"), false);
	assert.equal(isAutomaticMessage("ada@example.com", { "List-Id": "<news.example.com>" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { "X-Autoreply": "yes" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { "X-Autorespond": "1" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { "X-Auto-Response-Suppress": "All" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { "Auto-Submitted": "auto-replied" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { "Auto-Submitted": "No" }), false);
	assert.equal(isAutomaticMessage("ada@example.com", { Precedence: "Bulk" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { Precedence: "list" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { Precedence: "junk" }), true);
	assert.equal(isAutomaticMessage("ada@example.com", { Precedence: "first-class" }), false);
});

test("list, bulk and no-reply detection", () => {
	const plain = collectFacts({ message: message() });
	assert.equal(plain.bulk, false);
	assert.equal(plain.list, false);
	assert.equal(plain.automatic, false);
	assert.equal(plain.listUnsubscribe, null);

	const list = collectFacts({
		message: message(),
		headers: { "List-Id": "<news.example.com>", "List-Unsubscribe": "<https://news.example.com/u>" },
	});
	assert.equal(list.list, true);
	assert.equal(list.bulk, true);
	assert.equal(list.automatic, true);
	assert.equal(list.listUnsubscribe, "<https://news.example.com/u>");

	const bulk = collectFacts({ message: message(), headers: { precedence: "bulk" } });
	assert.equal(bulk.bulk, true);
	assert.equal(bulk.list, false);

	const unsubscribeOnly = collectFacts({ message: message(), headers: { "list-unsubscribe": "<mailto:u@x.test>" } });
	assert.equal(unsubscribeOnly.bulk, true);

	const noReply = collectFacts({ message: message({ fromAddr: "Shop <no-reply@shop.test>" }) });
	assert.equal(noReply.noReply, true);
	assert.equal(noReply.automatic, true);
	assert.equal(noReply.senderAddress, "no-reply@shop.test");
	assert.equal(noReply.senderName, "Shop");
});

test("auth signals come from spam_signals and absent signals mean not verified", () => {
	const none = collectFacts({ message: message() });
	assert.deepEqual(none.auth, { spf: "unknown", dkim: "unknown", dmarc: "unknown" });
	assert.equal(none.authPassed, false);
	assert.equal(none.authFailed, false);

	const passed = collectFacts({
		message: message({ spamSignals: signals("spf_passed", "dkim_passed", "dmarc_passed") }),
	});
	assert.deepEqual(passed.auth, { spf: "pass", dkim: "pass", dmarc: "pass" });
	assert.equal(passed.authPassed, true);

	const spfOnly = collectFacts({ message: message({ spamSignals: signals("spf_passed") }) });
	assert.equal(spfOnly.authPassed, false, "SPF alone does not verify the From domain");

	const dmarcFailed = collectFacts({ message: message({ spamSignals: signals("dkim_passed", "dmarc_failed") }) });
	assert.equal(dmarcFailed.auth.dmarc, "fail");
	assert.equal(dmarcFailed.authFailed, true);
	assert.equal(dmarcFailed.authPassed, false);
	assert.deepEqual(dmarcFailed.phishingSignals, ["dmarc_failed"]);

	for (const broken of ["not json", "{}", JSON.stringify([null, 3, { id: 7 }])]) {
		const facts = collectFacts({ message: message({ spamSignals: broken }) });
		assert.deepEqual(facts.auth, { spf: "unknown", dkim: "unknown", dmarc: "unknown" });
	}
});

test("known contacts come from relationship signals or manual/outbound contacts, not a mere contact row", () => {
	assert.equal(collectFacts({ message: message() }).knownContact, false);
	assert.equal(collectFacts({ message: message({ spamSignals: signals("manual_contact") }) }).knownContact, true);
	assert.equal(collectFacts({ message: message({ spamSignals: signals("previously_sent") }) }).knownContact, true);
	const contact = (source) => [{ email: "ADA@example.com", displayName: "Ada Lovelace", source }];
	assert.equal(collectFacts({ message: message(), contacts: contact("inbound") }).knownContact, false);
	assert.equal(collectFacts({ message: message(), contacts: contact("manual") }).knownContact, true);
	assert.equal(collectFacts({ message: message(), contacts: contact("outbound") }).knownContact, true);
});

test("display-name spoofing of a known contact", () => {
	const contacts = [
		{ email: "ceo@corp.test", displayName: "Grace Hopper", source: "manual" },
		{ email: "pal@friend.test", displayName: "Al", source: "outbound" },
		{ email: "seen@inbound.test", displayName: "Inbound Only", source: "inbound" },
	];
	const spoof = collectFacts({ message: message({ fromAddr: '"grace  HOPPER" <ceo@evil.test>' }), contacts });
	assert.equal(spoof.spoofedContact, "ceo@corp.test");
	assert.ok(spoof.phishingSignals.includes("display_name_spoof"));
	assert.equal(spoof.knownContact, false);

	assert.equal(findSpoofedContact("ceo@corp.test", "Grace Hopper", contacts), null, "the real contact is not a spoof");
	assert.equal(findSpoofedContact("x@evil.test", "ceo@corp.test", contacts), "ceo@corp.test", "address as name");
	assert.equal(findSpoofedContact("x@evil.test", "Inbound Only", contacts), null, "inbound contacts do not count");
	assert.equal(findSpoofedContact("x@evil.test", "Al", contacts), "pal@friend.test", "short names count too");
	assert.equal(findSpoofedContact("x@evil.test", " al ", contacts), "pal@friend.test");
	assert.equal(findSpoofedContact("pal@friend.test", "Al", contacts), null);
	const short = collectFacts({ message: message({ fromAddr: "Al <x@evil.test>" }), contacts });
	assert.ok(short.phishingSignals.includes("display_name_spoof"));
	assert.equal(findSpoofedContact("x@evil.test", null, contacts), null);
	assert.equal(collectFacts({ message: message({ fromAddr: "x@evil.test" }), contacts }).spoofedContact, null);
});

test("phishing signals from the verdict and URL analyzers", () => {
	const facts = collectFacts({
		message: message({
			spamVerdict: "suspicious",
			spamSignals: signals("displayed_link_mismatch", "ip_address_url", "punycode_url", "spf_failed", "dkim_failed"),
		}),
	});
	assert.equal(facts.suspicious, true);
	assert.deepEqual(facts.phishingSignals, [
		"suspicious_verdict",
		"displayed_link_mismatch",
		"ip_address_url",
		"punycode_url",
		"spf_failed",
		"dkim_failed",
	]);
	assert.equal(collectFacts({ message: message({ spamVerdict: "weird" }) }).spamVerdict, null);
	assert.equal(collectFacts({ message: message({ spamVerdict: "spam" }) }).spamVerdict, "spam");
});

test(".ics detection from text/calendar content types with parameters or a .ics filename", () => {
	assert.equal(isCalendarAttachment({ filename: "invite", contentType: "text/calendar" }), true);
	assert.equal(
		isCalendarAttachment({ filename: "x.bin", contentType: 'Text/Calendar; method=REQUEST; charset="utf-8"' }),
		true,
	);
	assert.equal(isCalendarAttachment({ filename: "x", contentType: "application/ics" }), true);
	assert.equal(isCalendarAttachment({ filename: "Meeting.ICS", contentType: "application/octet-stream" }), true);
	assert.equal(isCalendarAttachment({ filename: "notes.txt", contentType: "text/plain" }), false);
	assert.equal(isCalendarAttachment({ filename: "ics.pdf", contentType: "application/pdf" }), false);
	const facts = collectFacts({
		message: message(),
		attachments: [
			{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST", size: 900 },
			{ filename: "agenda.pdf", contentType: "application/pdf", size: 100 },
		],
	});
	assert.deepEqual(
		facts.inviteAttachments.map((attachment) => attachment.filename),
		["invite.ics"],
	);
});

test("body length prefers readable text and falls back to the text body", () => {
	assert.equal(collectFacts({ message: message({ textBody: "abc" }) }).bodyLength, 3);
	assert.equal(collectFacts({ message: message({ textBody: null }), bodyText: "hello" }).bodyLength, 5);
	assert.equal(collectFacts({ message: message({ textBody: null }) }).bodyLength, 0);
});

test("needsModel is false for bulk, list, no-reply and spam mail and when no capability needs it", () => {
	const person = collectFacts({ message: message() });
	assert.equal(needsModel(person, capabilities), true);
	assert.equal(needsModel(collectFacts({ message: message(), headers: { "List-Id": "x" } }), capabilities), false);
	assert.equal(needsModel(collectFacts({ message: message(), headers: { Precedence: "bulk" } }), capabilities), false);
	assert.equal(needsModel(collectFacts({ message: message({ fromAddr: "noreply@x.test" }) }), capabilities), false);
	assert.equal(needsModel(collectFacts({ message: message({ spamVerdict: "spam" }) }), capabilities), false);
	assert.equal(
		needsModel(person, { ...capabilities, reply: false, summary: false, phishing: false }),
		false,
		"calendar alone is deterministic",
	);
	assert.equal(needsModel(person, { ...capabilities, reply: false, summary: false }), true);
	assert.equal(needsModel(person, { ...capabilities, mutedSenders: ["ada@example.com"] }), false);
});
