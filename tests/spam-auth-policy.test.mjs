import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

// Invented mail only. The authentication policy (upstream Mailflare #216): a DMARC failure the sender's domain asks
// receivers to act on, or SPF and DKIM failing together, files mail as spam even from a known contact; a p=none or
// unknown policy only adds points, and no failure ever keeps the known-contact trust.

const {
	analyzeSpam,
	planAuthPolicy,
	publishedDmarcPolicy,
	parseDmarcRecord,
	dmarcRecordNames,
	dmarcPolicySource,
	readStrictDmarc,
	saveStrictDmarc,
	trustedCloudflareAuthenticationResults,
	sesAuthenticationResults,
	createDb,
	SqliteDatabase,
	applyMigrations,
} = await bundleModules("kite-spam-auth-policy-", [
	["analyzeSpam", "src/lib/spam/engine.ts"],
	["planAuthPolicy, publishedDmarcPolicy, parseDmarcRecord, dmarcRecordNames", "src/lib/spam/dmarc-policy-utils.ts"],
	["dmarcPolicySource, readStrictDmarc, saveStrictDmarc", "src/lib/spam/dmarc-policy.ts"],
	["trustedCloudflareAuthenticationResults, sesAuthenticationResults", "src/lib/spam/authentication-results-utils.ts"],
	["createDb", "src/db/index.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
]);

const FORGED_PASS =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=bank.test; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test";
const ids = (signals) => signals.map((signal) => signal.id).sort();

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'owner', 1);
		INSERT INTO contacts (id, user_id, email, source, created_at) VALUES ('c-1', 'owner', 'colleague@bank.test', 'outbound', 1);
		INSERT INTO contacts (id, user_id, email, source, created_at) VALUES ('c-2', 'owner', 'saved@bank.test', 'manual', 1);
	`);
	return { sqlite, db: createDb(sqlite) };
}

function message(from) {
	return {
		subject: "Quarterly figures",
		text: "Hi, the figures are attached as discussed. Thanks!",
		html: null,
		messageId: "<m@bank.test>",
		fromAddr: from,
		toAddr: "owner@example.com",
		ccAddr: null,
		bccAddr: null,
		inReplyTo: null,
		references: [],
		date: null,
		attachments: [],
	};
}

/** A policy source that records whether it was asked. */
function source({ strict = false, published = "unknown" } = {}) {
	const calls = { strict: 0, published: [] };
	return {
		calls,
		strict: async () => {
			calls.strict += 1;
			return strict;
		},
		published: async (domain) => {
			calls.published.push(domain);
			if (published instanceof Error) throw published;
			return published;
		},
	};
}

function analyze(db, { from = "Colleague <colleague@bank.test>", trusted, headers, dmarcPolicy } = {}) {
	return analyzeSpam(db, {
		mailboxId: "mailbox-a",
		userId: "owner",
		envelopeFrom: "bounce@bank.test",
		headers,
		authenticationResults: trusted,
		message: message(from),
		dmarcPolicy,
	});
}

const dmarcFail = (policy) =>
	`mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@bank.test; dkim=none; dmarc=fail header.from=bank.test${policy ? ` policy.dmarc=${policy}` : ""}`;

test("policy matrix: published policy × known contact or stranger", async (t) => {
	const { db } = await setup(t);
	const senders = {
		known: "Colleague <colleague@bank.test>",
		saved: "Saved <saved@bank.test>",
		stranger: "Someone <someone@bank.test>",
	};
	for (const [policy, expected] of [
		["reject", "spam"],
		["quarantine", "spam"],
		["none", "inbox"],
		[null, "inbox"],
	]) {
		for (const [who, from] of Object.entries(senders)) {
			const result = await analyze(db, { from, trusted: dmarcFail(policy), dmarcPolicy: source() });
			const label = `${policy ?? "unknown"} / ${who}`;
			assert.equal(result.verdict, expected, label);
			const signalIds = ids(result.signals);
			assert.ok(signalIds.includes("dmarc_failed"), label);
			assert.ok(!signalIds.includes("previously_sent") && !signalIds.includes("manual_contact"), label);
			if (expected === "spam") {
				assert.ok(result.score >= 70, label);
				const policySignal = result.signals.find((signal) => signal.id === "auth_policy");
				assert.equal(policySignal.metadata.cause, `dmarc_${policy}`, label);
			} else assert.ok(!signalIds.includes("auth_policy"), label);
		}
	}
});

test("the policy comes from the trusted header first, then DNS, and fails safe to unknown", async (t) => {
	const { db } = await setup(t);
	// Google's comment form names the policy without policy.dmarc.
	const google = "mx.cloudflare.net; dmarc=fail (p=QUARANTINE sp=NONE dis=QUARANTINE) header.from=bank.test";
	const fromHeader = source({ published: "none" });
	assert.equal((await analyze(db, { trusted: google, dmarcPolicy: fromHeader })).verdict, "spam");
	assert.deepEqual(fromHeader.calls, { strict: 0, published: [] }, "a policy in the header needs no lookup");

	const dns = source({ published: "reject" });
	const viaDns = await analyze(db, { trusted: dmarcFail(null), dmarcPolicy: dns });
	assert.equal(viaDns.verdict, "spam");
	assert.deepEqual(dns.calls.published, ["bank.test"]);

	for (const published of ["none", "unknown", new Error("SERVFAIL")]) {
		const result = await analyze(db, { trusted: dmarcFail(null), dmarcPolicy: source({ published }) });
		assert.equal(result.verdict, "inbox", String(published));
	}
	// Without a source (other callers) the policy is unknown.
	assert.equal((await analyze(db, { trusted: dmarcFail(null) })).verdict, "inbox");
	// A pass looks nothing up.
	const passing = source();
	await analyze(db, { trusted: FORGED_PASS, dmarcPolicy: passing });
	assert.deepEqual(passing.calls, { strict: 0, published: [] });
});

test("Treat every DMARC failure as spam files p=none and unknown failures too", async (t) => {
	const { db } = await setup(t);
	for (const policy of ["none", null]) {
		const strict = source({ strict: true });
		const result = await analyze(db, { trusted: dmarcFail(policy), dmarcPolicy: strict });
		assert.equal(result.verdict, "spam", String(policy));
		assert.equal(result.signals.find((signal) => signal.id === "auth_policy").metadata.cause, "dmarc_strict");
		assert.deepEqual(strict.calls.published, [], "the switch makes the lookup unnecessary");
	}
	// The switch does not touch mail that passed or did not fail DMARC.
	const strict = source({ strict: true });
	assert.equal((await analyze(db, { trusted: FORGED_PASS, dmarcPolicy: strict })).verdict, "inbox");
	assert.equal(
		(await analyze(db, { trusted: "mx.cloudflare.net; spf=fail smtp.mailfrom=x@bank.test", dmarcPolicy: strict }))
			.verdict,
		"inbox",
	);
	// A switch that cannot be read counts as off.
	const broken = { strict: async () => Promise.reject(new Error("db down")), published: async () => "none" };
	assert.equal((await analyze(db, { trusted: dmarcFail("none"), dmarcPolicy: broken })).verdict, "inbox");
});

test("SPF and DKIM failing without a DMARC result count as p=quarantine", async (t) => {
	const { db } = await setup(t);
	const both = "mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@bank.test; dkim=fail header.d=bank.test";
	for (const from of ["Colleague <colleague@bank.test>", "Someone <someone@bank.test>"]) {
		const result = await analyze(db, { from, trusted: both, dmarcPolicy: source() });
		assert.equal(result.verdict, "spam", from);
		assert.equal(result.signals.find((signal) => signal.id === "auth_policy").metadata.cause, "spf_and_dkim");
	}
	// One of them alone only adds points, and still costs a known contact the trust bonus.
	const spfOnly = await analyze(db, {
		trusted: "mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@bank.test; dkim=pass header.d=bank.test",
		dmarcPolicy: source(),
	});
	assert.equal(spfOnly.verdict, "inbox");
	assert.ok(!ids(spfOnly.signals).includes("previously_sent"));
});

test("a known contact keeps the trust bonus only when nothing failed", async (t) => {
	const { db } = await setup(t);
	const passed = await analyze(db, { trusted: FORGED_PASS, dmarcPolicy: source() });
	assert.ok(ids(passed.signals).includes("previously_sent"));
	const unknown = await analyze(db, { trusted: null, dmarcPolicy: source() });
	assert.ok(ids(unknown.signals).includes("previously_sent"));
	const saved = await analyze(db, { from: "Saved <saved@bank.test>", trusted: null });
	assert.ok(ids(saved.signals).includes("manual_contact"));
});

test("a forged pass in the message's own header never hides the trusted failure", async (t) => {
	const { db } = await setup(t);
	const joined = new Headers([
		["authentication-results", dmarcFail("reject")],
		["authentication-results", FORGED_PASS],
	]).get("authentication-results");
	const trusted = trustedCloudflareAuthenticationResults(joined, [dmarcFail("reject"), FORGED_PASS]);
	assert.equal(trusted, dmarcFail("reject"));
	const result = await analyze(db, { trusted, headers: { "authentication-results": joined }, dmarcPolicy: source() });
	assert.equal(result.verdict, "spam");
	assert.ok(!ids(result.signals).some((id) => id.endsWith("_passed")));

	// Direct SMTP without verification: the sender's header is not trusted at all, so nothing passes or fails.
	const untrusted = await analyze(db, {
		trusted: null,
		headers: { "authentication-results": FORGED_PASS },
		dmarcPolicy: source(),
	});
	assert.ok(!ids(untrusted.signals).some((id) => id.endsWith("_passed") || id === "auth_policy"));
	// A sender's copy below the trusted one cannot weaken the published policy either.
	const weakened = trustedCloudflareAuthenticationResults(
		new Headers([
			["authentication-results", dmarcFail("reject")],
			["authentication-results", "mx.cloudflare.net; dmarc=fail policy.dmarc=none"],
		]).get("authentication-results"),
		[dmarcFail("reject"), "mx.cloudflare.net; dmarc=fail policy.dmarc=none"],
	);
	assert.equal(publishedDmarcPolicy(weakened), "reject");
});

test("SES failures carry the published policy", async (t) => {
	const { db } = await setup(t);
	const value = sesAuthenticationResults({ spf: "FAIL", dkim: "FAIL", dmarc: "FAIL", dmarcPolicy: "REJECT" }, "");
	assert.equal(value, "amazonses.com; spf=fail; dkim=fail; dmarc=fail policy.dmarc=reject");
	assert.equal(
		sesAuthenticationResults({ dmarc: "FAIL", dmarcPolicy: "x; dmarc=pass" }, ""),
		"amazonses.com; dmarc=fail",
	);
	assert.equal((await analyze(db, { trusted: value, dmarcPolicy: source() })).verdict, "spam");
});

test("publishedDmarcPolicy reads policy.dmarc, the DMARCbis property and Google's comment, strictest first", () => {
	assert.equal(publishedDmarcPolicy(dmarcFail("reject")), "reject");
	assert.equal(
		publishedDmarcPolicy("mx.google.com; dmarc=fail (p=REJECT sp=NONE dis=NONE) header.from=a.test"),
		"reject",
	);
	assert.equal(publishedDmarcPolicy("x; dmarc=fail (p=NONE sp=REJECT) header.from=a.test"), "none");
	assert.equal(publishedDmarcPolicy("x; dmarc=fail policy.published-domain-policy=quarantine"), "quarantine");
	assert.equal(publishedDmarcPolicy("x; dmarc=fail policy.dmarc=none (p=reject)"), "reject");
	assert.equal(publishedDmarcPolicy("x; dmarc=fail header.from=a.test"), null);
	assert.equal(publishedDmarcPolicy("x; spf=fail (p=reject); dmarc=fail"), null, "only the dmarc clause counts");
	assert.equal(publishedDmarcPolicy("x; dmarc=fail policy.dmarc=bogus"), null);
	assert.equal(publishedDmarcPolicy('x; dmarc=fail header.from="a;b" policy.dmarc=quarantine'), "quarantine");
	assert.equal(publishedDmarcPolicy(null), null);
	assert.equal(publishedDmarcPolicy("x"), null);
});

test("planAuthPolicy", () => {
	const set = (...values) => new Set(values);
	assert.equal(planAuthPolicy(set("dmarc_failed"), { policy: "reject", strict: false }).cause, "dmarc_reject");
	assert.equal(planAuthPolicy(set("dmarc_failed"), { policy: "quarantine", strict: false }).cause, "dmarc_quarantine");
	assert.equal(planAuthPolicy(set("dmarc_failed"), { policy: "none", strict: false }), null);
	assert.equal(planAuthPolicy(set("dmarc_failed"), { policy: "unknown", strict: false }), null);
	assert.equal(planAuthPolicy(set("dmarc_failed"), { policy: "none", strict: true }).cause, "dmarc_strict");
	assert.equal(
		planAuthPolicy(set("spf_failed", "dkim_failed"), { policy: "unknown", strict: false }).cause,
		"spf_and_dkim",
	);
	assert.equal(
		planAuthPolicy(set("spf_failed", "dkim_failed", "dmarc_passed"), { policy: "unknown", strict: true }),
		null,
	);
	assert.equal(planAuthPolicy(set("spf_failed"), { policy: "reject", strict: true }), null);
	assert.equal(planAuthPolicy(set(), { policy: "reject", strict: true }), null);
});

test("parseDmarcRecord and dmarcRecordNames", () => {
	assert.equal(parseDmarcRecord(["v=DMARC1; p=reject; rua=mailto:d@a.test"]), "reject");
	assert.equal(parseDmarcRecord(["v=spf1 -all", "v=DMARC1;p=quarantine"]), "quarantine");
	assert.equal(parseDmarcRecord(["V=DMARC1; P=Reject"]), "reject");
	assert.equal(parseDmarcRecord(["v=spf1 -all"]), null);
	assert.equal(parseDmarcRecord([]), null);
	assert.equal(parseDmarcRecord(["v=DMARC1; p=reject", "v=DMARC1; p=none"]), "unknown");
	assert.equal(parseDmarcRecord(["v=DMARC1; rua=mailto:d@a.test"]), "unknown");
	assert.equal(parseDmarcRecord(["v=DMARC1; p=reject; pct=20"]), "quarantine");
	assert.equal(parseDmarcRecord(["v=DMARC1; p=quarantine; t=y"]), "none");
	assert.equal(parseDmarcRecord(["v=DMARC1; p=none; sp=reject"], true), "reject");
	assert.equal(parseDmarcRecord(["v=DMARC1; p=quarantine"], true), "quarantine");
	assert.deepEqual(dmarcRecordNames("Mail.Bank.Test"), [
		{ name: "_dmarc.mail.bank.test", inherited: false },
		{ name: "_dmarc.bank.test", inherited: true },
	]);
	assert.deepEqual(dmarcRecordNames("bank.co.uk"), [{ name: "_dmarc.bank.co.uk", inherited: false }]);
	assert.deepEqual(dmarcRecordNames("not a domain"), []);
	assert.deepEqual(dmarcRecordNames("localhost"), []);
});

// The lookup cache lives for the isolate, so every case below uses domains of its own.
test("published policies come from DNS, walk to the organizational domain, are cached and fail safe", async () => {
	const asked = [];
	const records = { "_dmarc.walk.test": ["v=DMARC1; p=none; sp=reject"] };
	let clock = Date.now();
	const env = {
		RESOLVE_TXT: async (name) => {
			asked.push(name);
			if (name.endsWith("broken.test") && !records[name]) throw new Error("SERVFAIL");
			return records[name] ?? [];
		},
	};
	const policy = dmarcPolicySource(env, { now: () => clock });
	assert.equal(await policy.published("mail.walk.test"), "reject");
	assert.deepEqual(asked, ["_dmarc.mail.walk.test", "_dmarc.walk.test"]);
	assert.equal(await policy.published("MAIL.walk.test"), "reject");
	assert.equal(asked.length, 2, "answered from the cache");
	assert.equal(await policy.published("walk.test"), "none");
	assert.equal(await policy.published("nothing.test"), "unknown");
	assert.equal(await policy.published("broken.test"), "unknown");

	const slow = dmarcPolicySource({ RESOLVE_TXT: () => new Promise(() => {}) }, { timeoutMs: 50 });
	const started = Date.now();
	assert.equal(await slow.published("slow.test"), "unknown");
	assert.ok(Date.now() - started < 2000);

	// An unknown answer is asked again after five minutes, a found one only after an hour.
	clock += 6 * 60_000;
	records["_dmarc.broken.test"] = ["v=DMARC1; p=quarantine"];
	assert.equal(await policy.published("broken.test"), "quarantine");
	records["_dmarc.walk.test"] = ["v=DMARC1; p=reject"];
	assert.equal(await policy.published("walk.test"), "none");
	clock += 60 * 60_000;
	assert.equal(await policy.published("walk.test"), "reject");
});

test("the switch is stored in app_settings and reads as off before migration 0084", async (t) => {
	const { sqlite } = await setup(t);
	const env = { DB: sqlite, RESOLVE_TXT: async (name) => (name === "_dmarc.bank.test" ? ["v=DMARC1; p=reject"] : []) };
	assert.deepEqual(await readStrictDmarc(env), { strictDmarc: false, migrationPending: false });
	await saveStrictDmarc(env, true);
	assert.deepEqual(await readStrictDmarc(env), { strictDmarc: true, migrationPending: false });
	const policy = dmarcPolicySource(env);
	assert.equal(await policy.strict(), true);
	assert.equal(await policy.published("switch.bank.test"), "reject", "inherited from bank.test");
	await saveStrictDmarc(env, false);
	assert.equal(await policy.strict(), false);

	sqlite.db.exec("ALTER TABLE app_settings DROP COLUMN spam_strict_dmarc");
	assert.deepEqual(await readStrictDmarc(env), { strictDmarc: false, migrationPending: true });
	assert.equal(await policy.strict(), false);
});
