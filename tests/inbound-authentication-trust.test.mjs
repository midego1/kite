import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Invented mail only. Each intake path either vouches for one Authentication-Results header or for
// none; a copy the sender wrote must never become a "passed" signal.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-auth-trust-");
after(() => rmSync(outDir, { recursive: true, force: true }));
const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		trust: source("lib/spam/authentication-results-utils.ts"),
		authentication: source("lib/spam/analyzers/authentication.ts"),
		engine: source("lib/spam/engine.ts"),
		intake: source("lib/email/intake.ts"),
		providerIntake: source("lib/email/provider-intake.ts"),
		relayHeaders: source("lib/email/relay-headers.ts"),
		rawHeaders: source("lib/email/raw-headers.ts"),
		relaySignature: source("lib/alerts/relay-signature.ts"),
		sesNotification: source("lib/aws/ses-notification.ts"),
		facts: source("lib/agent/auto-read/facts-utils.ts"),
		db: source("db/index.ts"),
		smtp: join(root, "server/runtime/smtp.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
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
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	// The real logger, not a bundled copy, so this file's runs do not stand in for its own tests' coverage.
	plugins: [
		{
			name: "real-logger",
			setup(build) {
				const logger = pathToFileURL(join(root, "src/lib/logger.mjs")).href;
				build.onResolve({ filter: /\/logger\.mjs$/ }, () => ({ path: logger, external: true }));
			},
		},
	],
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { trustedCloudflareAuthenticationResults, sesAuthenticationResults } = await load("trust");
const { completeRawHeaderValues } = await load("rawHeaders");
const { readRelaySignatureState, recordRelaySignatureProblem } = await load("relaySignature");
const { analyzeAuthentication } = await load("authentication");
const { analyzeSpam } = await load("engine");
const { intakeIncomingMail } = await load("intake");
const { intakeProviderMail } = await load("providerIntake");
const { readRelayHeaders } = await load("relayHeaders");
const { parseSesNotification } = await load("sesNotification");
const { collectFacts } = await load("facts");
const { createDb } = await load("db");
const { parseHeaders } = await load("smtp");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const CLOUDFLARE =
	"mx.cloudflare.net; spf=none smtp.mailfrom=stranger.test; dkim=none; dmarc=none header.from=bank.test";
const FORGED =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=bank.test; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test";
const SECRET = "test-only-relay-secret";
const ids = (signals) => signals.map((signal) => signal.id).sort();
const mime = (headers) =>
	new TextEncoder().encode(
		[
			...headers,
			"From: Bank <security@bank.test>",
			"To: owner@example.com",
			"Subject: Verify your account",
			"",
			"Hello",
		].join("\r\n"),
	).buffer;

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'owner', 1);
	`);
	const queued = [];
	const env = {
		DB: sqlite,
		BUCKET: { put: async () => null },
		INBOUND_QUEUE: { send: async (payload) => queued.push(payload) },
	};
	return { env, sqlite, queued };
}

/** What the Worker and relay hand on: Cloudflare's copy of `joined`, found with the raw fields. */
const viaCloudflare = (joined, raw = null) => trustedCloudflareAuthenticationResults(joined, raw);
/** The signals and the `authPassed` fact a trusted value gives mail From `security@bank.test`. */
function verdictOf(trusted) {
	const signals = analyzeAuthentication(trusted, "bank.test");
	const facts = collectFacts({
		message: {
			fromAddr: "Bank <security@bank.test>",
			subject: "Hello",
			textBody: "Hello",
			spamVerdict: "inbox",
			spamSignals: JSON.stringify(signals),
		},
	});
	return { ids: ids(signals), authPassed: facts.authPassed };
}
const joinFields = (...values) =>
	new Headers(values.map((value) => ["authentication-results", value])).get("authentication-results");

test("only the topmost Cloudflare Authentication-Results is trusted", () => {
	assert.equal(viaCloudflare(CLOUDFLARE), CLOUDFLARE);
	assert.equal(
		viaCloudflare("mx.cloudflare.net 1; dkim=pass header.d=a.test"),
		"mx.cloudflare.net 1; dkim=pass header.d=a.test",
	);
	assert.equal(viaCloudflare("MX.Cloudflare.NET; dkim=pass"), "MX.Cloudflare.NET; dkim=pass");
	// Another server's header on top means Cloudflare did not add one; anything below is the sender's.
	assert.equal(viaCloudflare(`mail.attacker.test; dmarc=pass, ${FORGED}`), null);
	assert.equal(viaCloudflare("mx.cloudflare.net.attacker.test; dmarc=pass"), null);
	assert.equal(viaCloudflare(""), null);
	assert.equal(viaCloudflare(undefined), null);
	// Headers joins repeated fields with ", " in order: the sender's copy below must not fill in methods.
	assert.equal(viaCloudflare(joinFields(CLOUDFLARE, FORGED)), CLOUDFLARE);
	const partial = "mx.cloudflare.net; spf=none smtp.mailfrom=stranger.test";
	for (const forgery of [
		FORGED,
		"mail.attacker.test (comment); dmarc=pass header.from=bank.test",
		"(see notes) mail.attacker.test; dmarc=pass",
		"mail.attacker.test (a (nested) note); dmarc=pass",
		'"mail.attacker.test"; dmarc=pass',
	]) {
		assert.equal(viaCloudflare(joinFields(partial, forgery)), partial, forgery);
		assert.deepEqual(verdictOf(viaCloudflare(joinFields(partial, forgery))), { ids: [], authPassed: false }, forgery);
	}
	// Text in the trusted copy that opens a comment or quote cannot swallow the boundary.
	const opened = 'mx.cloudflare.net; spf=none smtp.mailfrom="a(b"@stranger.test';
	assert.deepEqual(verdictOf(viaCloudflare(`${opened}, x) "; dmarc=pass`)).ids, []);
	assert.deepEqual(
		verdictOf(viaCloudflare("mx.cloudflare.net; spf=none smtp.mailfrom=a(b@x.test, x); dmarc=pass")).ids,
		[],
	);
});

test("a cut that may have lost results downgrades passes to unknown, never to pass", () => {
	// A comma before a failure: without the exact fields the failure is lost, so the pass must go too.
	const commaBeforeFail =
		"mx.cloudflare.net; dkim=pass header.d=bank.test header.s=s1 (key, rotated); dmarc=fail header.from=bank.test";
	assert.equal(viaCloudflare(commaBeforeFail), "mx.cloudflare.net; dkim=none header.d=bank.test header.s=s1");
	assert.deepEqual(verdictOf(viaCloudflare(commaBeforeFail)), { ids: [], authPassed: false });
	// Failures before the cut still count.
	assert.deepEqual(verdictOf(viaCloudflare("mx.cloudflare.net; dmarc=fail header.from=bank.test, x; dkim=pass")).ids, [
		"dmarc_failed",
	]);
	// Without a comma nothing is cut and nothing downgraded.
	assert.deepEqual(verdictOf(viaCloudflare(FORGED)), {
		ids: ["dkim_passed", "dmarc_passed", "spf_passed"],
		authPassed: true,
	});
});

test("the raw header block gives exact field boundaries wherever Cloudflare put its header", () => {
	const withComma = "mx.cloudflare.net; dkim=pass header.d=bank.test (key, rotated); dmarc=fail header.from=bank.test";
	const sender = "mail.attacker.test; dmarc=pass";
	// Cloudflare's header is the first raw field: kept whole, commas and all, so its failure counts.
	const inRaw = completeRawHeaderValues(
		mime([`Authentication-Results: ${withComma}`, `Authentication-Results: ${sender}`]),
		"authentication-results",
	);
	assert.deepEqual(inRaw, [withComma, sender]);
	assert.equal(viaCloudflare(joinFields(withComma, sender), inRaw), withComma);
	assert.deepEqual(verdictOf(viaCloudflare(joinFields(withComma, sender), inRaw)), {
		ids: ["dkim_passed", "dmarc_failed"],
		authPassed: false,
	});
	// Folded lines unfold to the same value.
	const folded = completeRawHeaderValues(
		mime([
			"Authentication-Results: mx.cloudflare.net;",
			"\tdkim=pass header.d=bank.test;",
			"  dmarc=pass header.from=bank.test",
		]),
		"authentication-results",
	);
	assert.equal(
		viaCloudflare("mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test", folded),
		"mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test",
	);
	// Only in the header map, ahead of the sender's raw copies: the leading part, found exactly.
	const onlyInMap = "mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test";
	const senderRaw = completeRawHeaderValues(mime([`Authentication-Results: ${sender}`]), "authentication-results");
	assert.equal(viaCloudflare(joinFields(onlyInMap, sender), senderRaw), onlyInMap);
	// No raw copy at all: the whole map is Cloudflare's.
	const none = completeRawHeaderValues(mime([]), "authentication-results");
	assert.deepEqual(none, []);
	assert.equal(viaCloudflare(onlyInMap, none), onlyInMap);
	// A leading part found by difference may not contain a comma: it falls back to the downgrading cut.
	assert.deepEqual(verdictOf(viaCloudflare(joinFields(withComma, sender), senderRaw)), { ids: [], authPassed: false });
	// Cloudflare's single copy with a comma in a comment, no sender copies: its passes stand.
	const spfComment =
		"mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test; spf=pass (mx.cloudflare.net: domain of bounce@bank.test designates 192.0.2.1, 192.0.2.2 as permitted senders) smtp.mailfrom=bounce@bank.test";
	assert.equal(viaCloudflare(spfComment, none), spfComment);
	assert.deepEqual(verdictOf(viaCloudflare(spfComment, none)), {
		ids: ["dkim_passed", "dmarc_passed", "spf_passed"],
		authPassed: true,
	});
	// The same copy with the raw fields unknown is cut and downgraded.
	assert.deepEqual(verdictOf(viaCloudflare(spfComment, null)).ids, []);
	// A raw block that mentions the field but yields no field is ambiguous, not "none".
	assert.equal(
		completeRawHeaderValues(
			mime(["X-Note: see authentication-results below", " Authentication-Results: x"]),
			"authentication-results",
		),
		null,
	);
	// Raw fields that do not match the map, or a header block not read whole, fall back too.
	assert.deepEqual(verdictOf(viaCloudflare(joinFields(withComma, sender), ["something else"])).ids, []);
	const huge = new TextEncoder().encode(`X-Pad: ${"a".repeat(1024 * 1024 + 10)}\r\nSubject: x\r\n\r\nbody`).buffer;
	assert.equal(completeRawHeaderValues(huge, "authentication-results"), null);
});

test("SPF speaks for the envelope sender, not the HELO name, in Cloudflare's format", () => {
	const cloudflare = (helo, mailfrom) =>
		`mx.cloudflare.net; dkim=pass header.d=bank.test header.s=s1 header.b=AbC/12+x; dmarc=pass header.from=bank.test policy.dmarc=reject; spf=${helo} (mx.cloudflare.net: no SPF records found for postmaster@mta.bank.test) smtp.helo=mta.bank.test; spf=${mailfrom} (mx.cloudflare.net: domain of bounce@bank.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@bank.test; arc=none smtp.remote-ip=192.0.2.1`;
	assert.deepEqual(verdictOf(viaCloudflare(cloudflare("none", "pass"))).ids, [
		"dkim_passed",
		"dmarc_passed",
		"spf_passed",
	]);
	// The envelope check failed even though the HELO check passed; DMARC still passes, so it verifies.
	assert.deepEqual(verdictOf(viaCloudflare(cloudflare("pass", "fail"))), {
		ids: ["dkim_passed", "dmarc_passed", "spf_failed"],
		authPassed: true,
	});
	// A HELO-only result says nothing about the sender.
	assert.deepEqual(verdictOf("mx.cloudflare.net; spf=fail smtp.helo=mta.bank.test").ids, []);
	assert.deepEqual(verdictOf("mx.cloudflare.net; spf=pass").ids, ["spf_passed"]);
});

test("DKIM alone authenticates only a signature aligned with the From domain", () => {
	assert.deepEqual(verdictOf("mx.cloudflare.net; dkim=pass header.d=esp.test"), {
		ids: ["dkim_passed"],
		authPassed: false,
	});
	assert.deepEqual(verdictOf("mx.cloudflare.net; dkim=pass header.d=mail.bank.test"), {
		ids: ["dkim_passed"],
		authPassed: true,
	});
	assert.equal(verdictOf("mx.cloudflare.net; dkim=pass header.i=@bank.test").authPassed, true);
	assert.equal(verdictOf("mx.cloudflare.net; dkim=pass").authPassed, false);
	// Look-alike domains do not align.
	assert.equal(verdictOf("mx.cloudflare.net; dkim=pass header.d=bank.test.esp.test").authPassed, false);
	assert.equal(verdictOf("mx.cloudflare.net; dkim=pass header.d=notbank.test").authPassed, false);
	// One aligned signature among several is enough; DMARC passing is enough on its own.
	assert.equal(
		verdictOf("mx.cloudflare.net; dkim=pass header.d=esp.test; dkim=pass header.d=bank.test").authPassed,
		true,
	);
	assert.equal(
		verdictOf("mx.cloudflare.net; dkim=pass header.d=esp.test; dmarc=pass header.from=bank.test").authPassed,
		true,
	);
	// Without a DMARC pass, any failure still wins over an aligned DKIM signature.
	assert.equal(
		verdictOf("mx.cloudflare.net; dkim=pass header.d=bank.test; spf=fail smtp.mailfrom=x@bank.test").authPassed,
		false,
	);
	// A DMARC pass outweighs a failed SPF check (a forwarded message), and the failure is still reported.
	const forwarded = verdictOf(
		"mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test; spf=fail smtp.mailfrom=x@relay.test",
	);
	assert.deepEqual(forwarded, { ids: ["dkim_passed", "dmarc_passed", "spf_failed"], authPassed: true });
	const forwardedFacts = collectFacts({
		message: {
			fromAddr: "Bank <security@bank.test>",
			subject: "Hello",
			textBody: "Hello",
			spamVerdict: "inbox",
			spamSignals: JSON.stringify(analyzeAuthentication("mx.cloudflare.net; dmarc=pass; spf=fail", "bank.test")),
		},
	});
	assert.equal(forwardedFacts.authPassed, true);
	assert.ok(forwardedFacts.phishingSignals.includes("spf_failed"));
	assert.equal(verdictOf("mx.cloudflare.net; dmarc=fail; spf=pass smtp.mailfrom=x@bank.test").authPassed, false);
	// A stored dkim_passed signal without the aligned flag (analyzed before this check) is not enough.
	const old = collectFacts({
		message: {
			fromAddr: "Bank <security@bank.test>",
			subject: "Hello",
			textBody: "Hello",
			spamVerdict: "inbox",
			spamSignals: JSON.stringify([{ id: "dkim_passed", score: -4, reason: "DKIM authentication passed" }]),
		},
	});
	assert.equal(old.authPassed, false);
});

test("direct SMTP: a forged Authentication-Results is queued without trust and analyzed as unknown", async (t) => {
	const { env, sqlite, queued } = await setup(t);
	const raw = mime([`Authentication-Results: ${FORGED}`]);
	const headers = parseHeaders(Buffer.from(raw));
	assert.equal(headers["authentication-results"], FORGED, "the listener still records the sender's header");
	const result = await intakeIncomingMail(env, { from: "x@bank.test", to: "owner@example.com", raw, headers }, {});
	assert.equal(result.action, "store");
	assert.equal(queued.length, 1);
	assert.equal(queued[0].authenticationResults, null);

	const analysis = await analyzeSpam(createDb(sqlite), {
		mailboxId: "mailbox-a",
		userId: "owner",
		envelopeFrom: "x@bank.test",
		headers: queued[0].headers,
		authenticationResults: queued[0].authenticationResults,
		message: {
			subject: "Verify your account",
			text: "Hello",
			html: null,
			messageId: "<m@bank.test>",
			fromAddr: "Bank <security@bank.test>",
			toAddr: "owner@example.com",
			ccAddr: null,
			bccAddr: null,
			inReplyTo: null,
			references: [],
			date: null,
			attachments: [],
		},
	});
	const signals = ids(analysis.signals);
	assert.ok(!signals.some((id) => id.endsWith("_passed")), signals.join(", "));
	const facts = collectFacts({
		message: {
			fromAddr: "Bank <security@bank.test>",
			subject: "Verify your account",
			textBody: "Hello",
			spamVerdict: analysis.verdict,
			spamSignals: JSON.stringify(analysis.signals),
		},
		headers: queued[0].headers,
	});
	assert.equal(facts.authPassed, false);
	assert.equal(facts.auth.dmarc, "unknown");
});

test("Cloudflare hops: the intake's trusted value is what gets queued", async (t) => {
	const { env, queued } = await setup(t);
	const raw = mime([`Authentication-Results: ${CLOUDFLARE}`, `Authentication-Results: ${FORGED}`]);
	const headers = Object.fromEntries(
		new Headers([
			["authentication-results", CLOUDFLARE],
			["authentication-results", FORGED],
		]),
	);
	await intakeIncomingMail(
		env,
		{
			from: "x@bank.test",
			to: "owner@example.com",
			raw,
			headers,
			authenticationResults: trustedCloudflareAuthenticationResults(
				headers["authentication-results"],
				completeRawHeaderValues(raw, "authentication-results"),
			),
		},
		{},
	);
	assert.equal(queued[0].authenticationResults, CLOUDFLARE);
	assert.ok(!ids(analyzeAuthentication(queued[0].authenticationResults)).includes("dmarc_passed"));
});

const HEADERS_KEY = createHmac("sha256", SECRET).update("kite-relay-headers-signature-key-v1").digest();

function relayRequest(raw, headersJson, { sign = "derived", tamper = null } = {}) {
	const from = "x@bank.test";
	const to = "owner@example.com";
	const headers = new Headers({ "X-Kite-Headers": tamper ?? headersJson });
	const key = { derived: HEADERS_KEY, legacy: SECRET, wrong: "another-secret" }[sign];
	if (key)
		headers.set(
			"X-Kite-Headers-Signature",
			createHmac("sha256", key)
				.update(`kite-headers\n${from}\n${to}\n${headersJson}\n`)
				.update(new Uint8Array(raw))
				.digest("hex"),
		);
	return readRelayHeaders(SECRET, headers, raw, from, to);
}

/** The JSON log lines written while `run` runs, with their console level. */
async function captureLogs(run) {
	const lines = [];
	const original = { warn: console.warn, error: console.error };
	console.warn = (line) => lines.push({ level: "warn", ...JSON.parse(String(line)) });
	console.error = (line) => lines.push({ level: "error", ...JSON.parse(String(line)) });
	try {
		await run();
	} finally {
		Object.assign(console, original);
	}
	return lines;
}

test("relay: Authentication-Results counts only with a valid headers signature", async () => {
	const raw = mime([`Authentication-Results: ${FORGED}`]);
	const trusted = JSON.stringify({ "authentication-results": CLOUDFLARE, subject: "Verify your account" });
	const signed = await relayRequest(raw, trusted);
	assert.equal(signed.signature, "valid");
	assert.equal(signed.authenticationResults, CLOUDFLARE);
	// A relay from before the headers signature: the map is kept, its authentication is not.
	const unsigned = await relayRequest(raw, trusted, { sign: null });
	assert.equal(unsigned.signature, "missing");
	assert.equal(unsigned.authenticationResults, null);
	assert.equal(unsigned.headers.subject, "Verify your account");
	// The first headers signature, keyed with the secret itself, is still accepted for a while.
	const legacy = await relayRequest(raw, trusted, { sign: "legacy" });
	assert.equal(legacy.signature, "legacy");
	assert.equal(legacy.authenticationResults, CLOUDFLARE);
	// A map changed after signing, or signed with another key.
	const swapped = JSON.stringify({ "authentication-results": FORGED });
	assert.equal((await relayRequest(raw, trusted, { tamper: swapped })).signature, "invalid");
	assert.equal((await relayRequest(raw, trusted, { tamper: swapped })).authenticationResults, null);
	assert.equal((await relayRequest(raw, trusted, { sign: "wrong" })).authenticationResults, null);
	// A signed map whose topmost header is not Cloudflare's.
	const foreign = JSON.stringify({ "authentication-results": `mail.attacker.test; dmarc=pass, ${FORGED}` });
	assert.equal((await relayRequest(raw, foreign)).authenticationResults, null);
	assert.equal((await relayRequest(raw, "not json", { sign: null })).authenticationResults, null);
});

test("relay: a missing headers signature warns and a wrong one is an error, each at most every ten minutes", async () => {
	const raw = mime([]);
	const json = JSON.stringify({ "authentication-results": CLOUDFLARE });
	// Earlier tests in this file may have logged already; a fresh bundle has fresh rate limits.
	const fresh = await import(`${pathToFileURL(join(outDir, "relayHeaders.mjs")).href}?fresh`);
	const lines = await captureLogs(async () => {
		for (const sign of [null, null, "wrong", "wrong", "derived"]) {
			const headers = new Headers({ "X-Kite-Headers": json });
			if (sign)
				headers.set(
					"X-Kite-Headers-Signature",
					createHmac("sha256", sign === "wrong" ? "another-secret" : HEADERS_KEY)
						.update(`kite-headers\nx@bank.test\nowner@example.com\n${json}\n`)
						.update(new Uint8Array(raw))
						.digest("hex"),
				);
			await fresh.readRelayHeaders(SECRET, headers, raw, "x@bank.test", "owner@example.com");
		}
	});
	assert.deepEqual(
		lines.map((line) => [line.level, line.event]),
		[
			["warn", "relay.headers_signature_missing"],
			["error", "relay.headers_signature_invalid"],
		],
	);
	assert.ok(!JSON.stringify(lines).includes(SECRET));
});

test("relay: signature problems are recorded for the operational alert", async () => {
	const objects = new Map();
	const env = {
		BUCKET: {
			get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
			put: async (key, value) => objects.set(key, value),
		},
	};
	assert.deepEqual(await readRelaySignatureState(env), {});
	await recordRelaySignatureProblem(env, "missing", 1_000_000);
	await recordRelaySignatureProblem(env, "missing", 1_000_000 + 60_000);
	await recordRelaySignatureProblem(env, "invalid", 1_000_000 + 60_000);
	assert.deepEqual(await readRelaySignatureState(env), { missingAt: 1_000_000, invalidAt: 1_060_000 });
	await recordRelaySignatureProblem(env, "legacy", 1_000_000);
	assert.equal((await readRelaySignatureState(env)).legacyAt, 1_000_000);
	await recordRelaySignatureProblem(env, "missing", 1_000_000 + 11 * 60_000);
	assert.equal((await readRelaySignatureState(env)).missingAt, 1_660_000);
	objects.set("system/relay-signature.json", "not json");
	assert.deepEqual(await readRelaySignatureState(env), {});
});

const sesNotification = (receipt, headers = []) =>
	parseSesNotification(
		JSON.stringify({
			notificationType: "Received",
			mail: { source: "x@bank.test", destination: ["owner@example.com"], headers },
			receipt: {
				recipients: ["owner@example.com"],
				action: { type: "S3", bucketName: "b", objectKey: "k" },
				...receipt,
			},
		}),
	);

test("SES: its own receipt verdicts count, the message's Authentication-Results never do", async (t) => {
	const { env, queued } = await setup(t);
	const raw = mime([
		"Authentication-Results: amazonses.com; spf=pass; dmarc=none",
		`Authentication-Results: ${FORGED}`,
	]);
	const notification = sesNotification(
		{ spfVerdict: { status: "PASS" }, dkimVerdict: { status: "PASS" }, dmarcVerdict: { status: "FAIL" } },
		[
			{ name: "Authentication-Results", value: "amazonses.com; spf=pass; dmarc=none" },
			{ name: "Authentication-Results", value: FORGED },
		],
	);
	assert.equal(
		notification.authenticationResults,
		"amazonses.com; spf=pass smtp.mailfrom=x@bank.test; dkim=pass; dmarc=fail",
	);
	const ses = await intakeProviderMail(env, {
		from: notification.from,
		recipients: notification.recipients,
		raw,
		headers: notification.headers,
		authenticationResults: notification.authenticationResults,
	});
	const resend = await intakeProviderMail(env, { from: "x@bank.test", recipients: ["owner@example.com"], raw });
	assert.equal(ses.delivered + resend.delivered, 2);
	assert.deepEqual(
		queued.map((payload) => payload.authenticationResults),
		[notification.authenticationResults, null],
	);
	// DMARC failed: not verified. DKIM alone has no signing domain from SES, so it never aligns.
	assert.deepEqual(verdictOf(queued[0].authenticationResults), {
		ids: ["dkim_passed", "dmarc_failed", "spf_passed"],
		authPassed: false,
	});
	const dkimOnly = sesNotification({ dkimVerdict: { status: "PASS" }, dmarcVerdict: { status: "GRAY" } });
	assert.equal(verdictOf(dkimOnly.authenticationResults).authPassed, false);
	const dmarc = sesNotification({
		spfVerdict: { status: "PASS" },
		dkimVerdict: { status: "PASS" },
		dmarcVerdict: { status: "PASS" },
	});
	assert.equal(verdictOf(dmarc.authenticationResults).authPassed, true);
	assert.equal(sesNotification({}).authenticationResults, null);
	assert.equal(
		sesNotification({ spfVerdict: { status: "PROCESSING_FAILED" } }).authenticationResults,
		"amazonses.com; spf=temperror smtp.mailfrom=x@bank.test",
	);
	// An envelope sender that is not a plain address never becomes part of the value.
	assert.equal(sesAuthenticationResults({ spf: "PASS" }, '"a; dmarc=pass"@bank.test'), "amazonses.com; spf=pass");
});
