import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// "Recheck authentication" for connected Gmail and Google Workspace accounts (spec §6.6.1): which accounts are
// eligible, which messages already have a result and must be left alone, and what one message's recheck decides
// given Google's own topmost header (or a forged or missing one, which `externalAuthenticationResults` already
// pins in tests/external-sync-utils.test.mjs).

const {
	authRecheckAuthservId,
	parseStoredSignals,
	hasAuthenticationSignal,
	recheckSignals,
	authRecheckMessage,
	isAuthRecheckMessage,
	authRecheckView,
} = await bundleModules("kite-auth-recheck-utils-", [
	[
		"authRecheckAuthservId, parseStoredSignals, hasAuthenticationSignal, recheckSignals, authRecheckMessage, isAuthRecheckMessage, authRecheckView",
		"src/lib/external-accounts/auth-recheck-utils.ts",
	],
]);

const field = (name, value) => ({ name, value });
const GOOGLE =
	"mx.google.com; dkim=pass header.i=@vendor.example header.s=sel header.b=x; dmarc=pass header.from=vendor.example";
const RECEIVED = field("received", "from mail.vendor.example by mx.google.com with ESMTPS id x;");
const DELIVERED = [RECEIVED, field("authentication-results", GOOGLE)];

test("authRecheckAuthservId only trusts Gmail and Google Workspace, with their own host and trust flag", () => {
	const base = { preset: "gmail", trustAuthResults: true, imapHost: "imap.gmail.com" };
	assert.equal(authRecheckAuthservId(base, "mx.google.com"), "mx.google.com");
	assert.equal(authRecheckAuthservId({ ...base, preset: "google_workspace" }, "mx.google.com"), "mx.google.com");
	// A case-different host still matches; a different host never does.
	assert.equal(authRecheckAuthservId({ ...base, imapHost: "IMAP.GMAIL.COM" }, "mx.google.com"), "mx.google.com");
	assert.equal(authRecheckAuthservId({ ...base, imapHost: "imap.gmail.com.evil.example" }, "mx.google.com"), null);
	assert.equal(authRecheckAuthservId({ ...base, preset: "other" }, "mx.google.com"), null);
	assert.equal(authRecheckAuthservId({ ...base, preset: "icloud" }, "mx.google.com"), null);
	assert.equal(authRecheckAuthservId({ ...base, trustAuthResults: false }, "mx.google.com"), null);
	assert.equal(authRecheckAuthservId(base, null), null);
});

test("stored signals parse defensively and the authentication methods are recognised", () => {
	assert.deepEqual(parseStoredSignals(null), []);
	assert.deepEqual(parseStoredSignals("not json"), []);
	assert.deepEqual(parseStoredSignals('{"not":"an array"}'), []);
	assert.deepEqual(parseStoredSignals("[]"), []);
	const signals = [{ id: "dmarc_passed", score: -5, reason: "x" }];
	assert.deepEqual(parseStoredSignals(JSON.stringify(signals)), signals);
	assert.equal(hasAuthenticationSignal([]), false);
	assert.equal(hasAuthenticationSignal([{ id: "billing_sender", score: 0, reason: "x" }]), false);
	for (const id of ["dmarc_passed", "dmarc_failed", "dkim_passed", "dkim_failed", "spf_passed", "spf_failed"])
		assert.equal(hasAuthenticationSignal([{ id, score: 0, reason: "x" }]), true, id);
});

test("recheckSignals leaves a message alone once it already has an authentication signal", () => {
	const existing = JSON.stringify([{ id: "dmarc_failed", score: 10, reason: "already analyzed" }]);
	assert.deepEqual(recheckSignals(existing, DELIVERED, "mx.google.com", "billing@vendor.example"), {
		kind: "unchanged",
	});
});

test("recheckSignals adds Google's authentication signals to a message that has none yet", () => {
	const outcome = recheckSignals(null, DELIVERED, "mx.google.com", "billing@vendor.example");
	assert.equal(outcome.kind, "updated");
	const ids = outcome.signals.map((signal) => signal.id).sort();
	assert.deepEqual(ids, ["dkim_passed", "dmarc_passed"]);
	// DKIM aligns with the From domain.
	const dkim = outcome.signals.find((signal) => signal.id === "dkim_passed");
	assert.equal(dkim.metadata.aligned, true);
});

test("recheckSignals finds nothing for a forged lower header, a wrong authserv-id or no header at all", () => {
	// A sender-planted header with no Google Received line above it never counts.
	assert.deepEqual(
		recheckSignals(null, [field("authentication-results", GOOGLE)], "mx.google.com", "billing@vendor.example"),
		{ kind: "unchanged" },
	);
	assert.deepEqual(recheckSignals(null, DELIVERED, "mx.google.com", "billing@vendor.example").kind, "updated");
	assert.deepEqual(recheckSignals(null, null, "mx.google.com", "billing@vendor.example"), { kind: "unchanged" });
	assert.deepEqual(recheckSignals(null, [RECEIVED], "mx.google.com", "billing@vendor.example"), { kind: "unchanged" });
});

test("the queue message kind round-trips and nothing else is mistaken for it", () => {
	const message = authRecheckMessage("xacct_1");
	assert.deepEqual(message, { kind: "accounts.auth_recheck", accountId: "xacct_1" });
	assert.ok(isAuthRecheckMessage(message));
	assert.equal(isAuthRecheckMessage({ kind: "accounts.sync", accountId: "xacct_1" }), false);
	assert.equal(isAuthRecheckMessage(null), false);
	assert.equal(isAuthRecheckMessage({ kind: "accounts.auth_recheck" }), false);
});

test("authRecheckView answers null before a recheck ever ran, and ISO strings once it has", () => {
	assert.equal(authRecheckView(null), null);
	const row = {
		status: "done",
		scanned: 42,
		updated: 3,
		skipped: 1,
		startedAt: new Date("2026-11-08T00:00:00Z"),
		finishedAt: new Date("2026-11-08T00:05:00Z"),
		error: null,
	};
	assert.deepEqual(authRecheckView(row), {
		status: "done",
		scanned: 42,
		updated: 3,
		skipped: 1,
		startedAt: "2026-11-08T00:00:00.000Z",
		finishedAt: "2026-11-08T00:05:00.000Z",
		error: null,
	});
});
