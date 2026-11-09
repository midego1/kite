import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Invented mail only.

const { analyzeAuthentication } = await bundleModules("kite-assistant-email-auth-", [
	["analyzeAuthentication", "src/lib/spam/analyzers/authentication.ts"],
]);
const { authPassedFromSignals, collectFacts } = await bundleModules("kite-assistant-email-auth-facts-", [
	["authPassedFromSignals, collectFacts", "src/lib/agent/auto-read/facts-utils.ts"],
]);

/** `authPassedFromSignals` fed `analyzeAuthentication`'s own return value, as the assistant by email calls it. */
function fromTrusted(trusted, fromDomain = "bank.test") {
	return authPassedFromSignals(analyzeAuthentication(trusted, fromDomain));
}

/** `collectFacts.authPassed` for the same trusted value, going through the stored-message path instead. */
function fromStoredMessage(trusted, fromDomain = "bank.test") {
	const signals = analyzeAuthentication(trusted, fromDomain);
	const facts = collectFacts({
		message: {
			fromAddr: `Bank <security@${fromDomain}>`,
			subject: "Hello",
			textBody: "Hello",
			spamVerdict: "inbox",
			spamSignals: JSON.stringify(signals),
		},
	});
	return facts.authPassed;
}

const CASES = [
	["a DMARC pass", "mx.cloudflare.net; dmarc=pass header.from=bank.test", true],
	[
		"an aligned DKIM pass with SPF absent (no forwarder breaking it)",
		"mx.cloudflare.net; dkim=pass header.d=bank.test",
		true,
	],
	["an unaligned DKIM pass", "mx.cloudflare.net; dkim=pass header.d=esp.test", false],
	["an SPF pass alone", "mx.cloudflare.net; spf=pass smtp.mailfrom=x@bank.test", false],
	[
		"a DMARC fail even with an aligned DKIM pass",
		"mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=fail header.from=bank.test",
		false,
	],
	["nothing at all", "mx.cloudflare.net; spf=none; dkim=none; dmarc=none", false],
	[
		"an aligned DKIM pass undone by a failed SPF check: without a DMARC pass, any failure wins",
		"mx.cloudflare.net; dkim=pass header.d=bank.test; spf=fail smtp.mailfrom=x@bank.test",
		false,
	],
	[
		"a DMARC pass outweighs a failed SPF check (a forwarded message)",
		"mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test; spf=fail smtp.mailfrom=x@relay.test",
		true,
	],
];

test("authPassedFromSignals agrees with collectFacts for every case", () => {
	for (const [label, trusted, expected] of CASES) {
		assert.equal(fromTrusted(trusted), expected, label);
		assert.equal(fromStoredMessage(trusted), expected, label);
		assert.equal(fromTrusted(trusted), fromStoredMessage(trusted), `${label}: the two callers must agree`);
	}
});

test("an SES DKIM pass alone never passes: SES names no signing domain, so it can never align", () => {
	// SES verdicts carry no header.d/header.i, so dkimDomain() is empty and alignment can never be true.
	const signals = analyzeAuthentication("amazonses.com; dkim=pass; spf=pass smtp.mailfrom=x@bank.test", "bank.test");
	assert.equal(
		signals.some((s) => s.id === "dkim_passed" && s.metadata?.aligned === true),
		false,
	);
	assert.equal(authPassedFromSignals(signals), false);
});

test("an SES DMARC pass counts, even with no DKIM signing domain to align (spec §5.2, Feature D)", () => {
	const signals = analyzeAuthentication(
		"amazonses.com; spf=pass smtp.mailfrom=x@bank.test; dkim=pass; dmarc=pass",
		"bank.test",
	);
	assert.equal(authPassedFromSignals(signals), true);
});

test("a payload without authenticationResults never passes (the SMTP listener, Resend)", () => {
	assert.deepEqual(analyzeAuthentication(null, "bank.test"), []);
	assert.deepEqual(analyzeAuthentication(undefined, "bank.test"), []);
	assert.equal(authPassedFromSignals([]), false);
	assert.equal(authPassedFromSignals(analyzeAuthentication(null, "bank.test")), false);
});

test("authPassedFromSignals is pure: unrelated signal ids and a missing metadata object are ignored", () => {
	assert.equal(authPassedFromSignals([{ id: "url_shortener" }, { id: "dkim_passed" }]), false);
	assert.equal(authPassedFromSignals([{ id: "dmarc_passed" }, { id: "spf_failed" }]), true);
});
