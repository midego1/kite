import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { collectFacts } from "../src/lib/agent/auto-read/facts-utils.ts";
import { assessPhishing, planSuggestions } from "../src/lib/agent/auto-read/policy-utils.ts";
import { linkHostsOf, summarizeLinks } from "../src/lib/spam/analyzers/link-host-utils.ts";

// Invented mail only: a benign and a hostile corpus run through the real link and authentication
// analyzers, the facts and the planner, with a model that flags every message as credential phishing.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-phishing-precision-");
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: {
		authentication: fileURLToPath(import.meta.resolve("../src/lib/spam/analyzers/authentication.ts")),
		urls: fileURLToPath(import.meta.resolve("../src/lib/spam/analyzers/urls.ts")),
		tokenizer: fileURLToPath(import.meta.resolve("../src/lib/spam/tokenizer.ts")),
		tokenizerUtils: fileURLToPath(import.meta.resolve("../src/lib/spam/tokenizer-utils.ts")),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	sourcemap: "inline",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { analyzeAuthentication } = await load("authentication");
const { analyzeUrls } = await load("urls");
const { prepareSpamContent } = await load("tokenizer");
const { htmlLinkText } = await load("tokenizerUtils");

const AUTH_PASS = "mx.cloudflare.net; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass header.from=x";
const AUTH_FAIL = "mx.cloudflare.net; spf=fail smtp.mailfrom=x; dkim=fail header.d=x; dmarc=fail header.from=x";
const OWN_DOMAINS = ["example.com"];
const CONTACTS = [{ email: "mira@corp.test", displayName: "Mira Fenwick", source: "manual" }];
const capabilities = {
	calendar: true,
	reply: true,
	summary: true,
	phishing: true,
	mutedSenders: [],
	trustedSenders: [],
	modules: {},
};
const settings = { capabilities, canDraftReply: true, filed: false, threadMessageCount: 1 };
const flagged = {
	category: "needs_reply",
	needsReply: true,
	urgency: "high",
	summary: "Asks the owner to sign in.",
	tasks: [],
	suspicious: { flagged: true, reasons: ["credential_request", "urgency_pressure"] },
};
const clean = { ...flagged, suspicious: { flagged: false, reasons: [] } };

function addressOf(from) {
	return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

/** What triage would see for one invented message, computed the way intake and triage context do. */
function factsFor(mail) {
	const message = {
		subject: mail.subject,
		text: mail.text ?? null,
		html: mail.html ?? null,
		messageId: "<m@example.test>",
		fromAddr: mail.from,
		toAddr: "owner@example.com",
		ccAddr: null,
		bccAddr: null,
		inReplyTo: null,
		references: [],
		date: null,
		attachments: [],
	};
	const headers = { "Authentication-Results": mail.auth ?? AUTH_PASS, ...mail.headers };
	const signals = [
		...analyzeAuthentication(headers["Authentication-Results"]),
		...analyzeUrls(message, prepareSpamContent(message)),
	];
	const sender = addressOf(mail.from);
	const domain = sender.split("@")[1];
	const hosts = linkHostsOf(`${mail.text ?? ""}\n${mail.html ? htmlLinkText(mail.html) : ""}`);
	return collectFacts({
		message: {
			fromAddr: mail.from,
			subject: mail.subject,
			textBody: mail.text ?? null,
			spamVerdict: "inbox",
			spamSignals: JSON.stringify(signals),
		},
		headers,
		contacts: mail.contacts ?? CONTACTS,
		ownDomain: OWN_DOMAINS.some((own) => domain === own || domain.endsWith(`.${own}`)),
		links: summarizeLinks(sender, hosts),
	});
}

const benign = {
	"an authenticated password reset from the install's own domain": {
		from: "Kite <no-reply@example.com>",
		subject: "Reset your password",
		text: "Someone asked to reset your password. Reset it here within 30 minutes: https://mail.example.com/reset?token=abc123",
		html: '<p>Reset it within 30 minutes:</p><a href="https://mail.example.com/reset?token=abc123">Reset password</a>',
		note: "model_flag_trusted_sender",
	},
	"a two-factor code from an authenticated service": {
		from: "Accounts <security@accounts.example.org>",
		subject: "Your sign-in code",
		text: "Your code is 481 516. If this wasn't you, secure your account now at https://accounts.example.org/security",
		note: "model_flag_unconfirmed",
	},
	"a receipt with links and images on the shop's domain": {
		from: "Shop <receipts@shop.example.net>",
		subject: "Your receipt #1042",
		html: '<img src="https://cdn.example.net/logo.png"><p>Total EUR 42.00</p><a href="https://shop.example.net/orders/1042">shop.example.net/orders/1042</a>',
		note: "model_flag_unconfirmed",
	},
	"a GitHub notification whose link text is its own URL": {
		from: "GitHub <notifications@github.com>",
		subject: "[org/repo] Sign-in from a new device",
		html: '<a href="https://github.com/settings/security-log">https://github.com/settings/security-log</a>',
		headers: { "List-Id": "<repo.org.github.com>" },
		note: "model_flag_unconfirmed",
	},
	"a Stripe notice with a tracking subdomain behind the shown name": {
		from: "Stripe <notifications@stripe.com>",
		subject: "Verify your login",
		html: '<a href="https://links.stripe.com/s/abc?u=1">stripe.com/dashboard</a>',
		note: "model_flag_unconfirmed",
	},
	"an SES notice whose link goes through the awstrack.me click tracker": {
		from: "Service <alerts@service.example.io>",
		subject: "Confirm your email",
		html: '<a href="https://abc.r.us-east-1.awstrack.me/L0/https:%2F%2Fservice.example.io%2Fconfirm%3Ft=9/1/0100abc">https://service.example.io/confirm</a>',
		note: "model_flag_unconfirmed",
	},
	"a shortened link from a known contact": {
		from: "Mira Fenwick <mira@corp.test>",
		subject: "Slides",
		text: "Slides are here: https://bit.ly/3slides",
		note: "model_flag_trusted_sender",
	},
};

const hostile = {
	"failed authentication with a credential request": {
		from: "IT Desk <helpdesk@example.org>",
		auth: AUTH_FAIL,
		subject: "Password expires today",
		text: "Confirm your password today: https://example.org/keep",
		reasons: ["spf_failed", "dkim_failed", "dmarc_failed", "credential_request", "urgency_pressure"],
	},
	"link text that shows one site and opens another": {
		from: "Example <security@example.com>",
		subject: "Unusual sign-in",
		html: '<a href="https://collect.evil.test/login">https://accounts.example.com/login</a>',
		reasons: ["displayed_link_mismatch", "credential_request", "urgency_pressure"],
	},
	"a bare host name as link text for another site": {
		from: "PayPal <service@paypal-billing.test>",
		subject: "Account limited",
		html: '<a href="https://evil.test/restore">www.paypal.com</a>',
		reasons: ["displayed_link_mismatch", "credential_request", "urgency_pressure"],
	},
	"a look-alike internationalized domain": {
		from: "Apple <id@apple-support.test>",
		subject: "Your Apple ID is locked",
		text: "Unlock it: https://xn--pple-43d.com/signin",
		reasons: ["punycode_url", "credential_request", "urgency_pressure"],
	},
	"an IPv4 link": {
		from: "Bank <alerts@bank.test>",
		subject: "Verify",
		text: "Verify at http://198.51.100.7/login",
		reasons: ["ip_address_url", "credential_request", "urgency_pressure"],
	},
	"an IPv6 link": {
		from: "Bank <alerts@bank.test>",
		subject: "Verify",
		text: "Verify at http://[2001:db8::7]/login",
		reasons: ["ip_address_url", "credential_request", "urgency_pressure"],
	},
	"a display name copied from a contact": {
		from: "Mira Fenwick <mira.fenwick@freemail.test>",
		subject: "Quick favour",
		text: "Can you buy gift cards for me today?",
		reasons: ["display_name_spoof", "credential_request", "urgency_pressure"],
	},
	"a shortened link from an unknown sender": {
		from: "Delivery <track@parcel.test>",
		subject: "Missed delivery",
		text: "Reschedule and pay the fee: https://bit.ly/3fee",
		reasons: ["url_shortener", "credential_request", "urgency_pressure"],
	},
};

for (const [name, mail] of Object.entries(benign))
	test(`benign: ${name} gets no phishing warning, flagged or not`, () => {
		const facts = factsFor(mail);
		assert.deepEqual(facts.phishingSignals, [], "no deterministic sign");
		const planned = planSuggestions({ facts, triage: flagged, settings });
		assert.ok(!planned.some((item) => item.kind === "phishing"), "no warning from the model flag");
		assert.ok(!planned.some((item) => item.kind === "reply"), "the flag still blocks the reply draft");
		assert.equal(assessPhishing(facts, flagged, capabilities).note, mail.note);
		assert.ok(!planSuggestions({ facts, triage: clean, settings }).some((item) => item.kind === "phishing"));
	});

for (const [name, mail] of Object.entries(hostile))
	test(`hostile: ${name} gets a phishing warning`, () => {
		const facts = factsFor(mail);
		const planned = planSuggestions({ facts, triage: flagged, settings });
		const warning = planned.find((item) => item.kind === "phishing");
		assert.ok(warning, "a warning");
		assert.deepEqual(warning.payload.reasons, mail.reasons);
		assert.equal(assessPhishing(facts, flagged, capabilities).note, null);
		assert.ok(!planned.some((item) => item.kind === "reply"));
	});

test("deterministic signs warn without the model, and trust never hides them", () => {
	const mismatch = factsFor(hostile["link text that shows one site and opens another"]);
	const trusted = { ...capabilities, trustedSenders: ["security@example.com"] };
	const planned = planSuggestions({ facts: mismatch, triage: clean, settings: { ...settings, capabilities: trusted } });
	assert.deepEqual(planned.find((item) => item.kind === "phishing")?.payload.reasons, ["displayed_link_mismatch"]);
	assert.deepEqual(planSuggestions({ facts: mismatch, triage: null, settings })[0].payload.reasons, [
		"displayed_link_mismatch",
	]);
});

test("a sender marked Not phishing is exempt from a model flag backed only by a supporting sign", () => {
	const facts = factsFor(hostile["a shortened link from an unknown sender"]);
	const trusted = { ...capabilities, trustedSenders: ["track@parcel.test"] };
	const planned = planSuggestions({ facts, triage: flagged, settings: { ...settings, capabilities: trusted } });
	assert.ok(!planned.some((item) => item.kind === "phishing"));
	assert.equal(assessPhishing(facts, flagged, trusted).note, "model_flag_trusted_sender");
});

test("a contact or marked sender without authentication is not exempt from a model flag", () => {
	const unauthenticated = "mx.cloudflare.net; spf=none smtp.mailfrom=x";
	const contact = factsFor({ ...benign["a shortened link from a known contact"], auth: unauthenticated });
	assert.equal(contact.knownContact, true);
	assert.equal(contact.authPassed, false);
	assert.ok(assessPhishing(contact, flagged, capabilities).reasons.includes("url_shortener"));
	const marked = factsFor({ ...hostile["a shortened link from an unknown sender"], auth: unauthenticated });
	const trusted = { ...capabilities, trustedSenders: ["track@parcel.test"] };
	assert.ok(assessPhishing(marked, flagged, trusted).reasons.includes("url_shortener"));
});

test("own-domain trust needs DMARC to pass and no copied contact name", () => {
	const reset = benign["an authenticated password reset from the install's own domain"];
	const shortened = { ...reset, text: `${reset.text}\nhttps://bit.ly/3x` };
	const dkimOnly = factsFor({ ...shortened, auth: "mx.cloudflare.net; dkim=pass header.d=x" });
	assert.equal(dkimOnly.authPassed, true);
	assert.deepEqual(assessPhishing(dkimOnly, flagged, capabilities).reasons, [
		"url_shortener",
		"credential_request",
		"urgency_pressure",
	]);
	const spoof = factsFor({
		...shortened,
		from: "Mira Fenwick <no-reply@example.com>",
	});
	assert.equal(spoof.spoofedContact, "mira@corp.test");
	assert.ok(assessPhishing(spoof, flagged, capabilities).reasons.includes("display_name_spoof"));
	const owned = factsFor(shortened);
	assert.equal(owned.ownDomain, true);
	assert.equal(assessPhishing(owned, flagged, capabilities).note, "model_flag_trusted_sender");
});
