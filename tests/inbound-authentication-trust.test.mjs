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
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { trustedCloudflareAuthenticationResults, topmostAuthenticationResults } = await load("trust");
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

test("only the topmost Cloudflare Authentication-Results is trusted", () => {
	assert.equal(trustedCloudflareAuthenticationResults(CLOUDFLARE), CLOUDFLARE);
	assert.equal(
		trustedCloudflareAuthenticationResults(`mx.cloudflare.net 1; dkim=pass header.d=a.test`),
		"mx.cloudflare.net 1; dkim=pass header.d=a.test",
	);
	assert.equal(trustedCloudflareAuthenticationResults("MX.Cloudflare.NET; dkim=pass"), "MX.Cloudflare.NET; dkim=pass");
	// Another server's header on top means Cloudflare did not add one; anything below is the sender's.
	assert.equal(trustedCloudflareAuthenticationResults(`mail.attacker.test; dmarc=pass, ${FORGED}`), null);
	assert.equal(trustedCloudflareAuthenticationResults("mx.cloudflare.net.attacker.test; dmarc=pass"), null);
	assert.equal(trustedCloudflareAuthenticationResults(""), null);
	assert.equal(trustedCloudflareAuthenticationResults(undefined), null);
	// Headers joins repeated fields with ", " in order: the sender's copy below must not fill in methods.
	const joined = new Headers([
		["authentication-results", CLOUDFLARE],
		["authentication-results", FORGED],
	]).get("authentication-results");
	assert.equal(trustedCloudflareAuthenticationResults(joined), CLOUDFLARE);
	const partial = "mx.cloudflare.net; spf=none smtp.mailfrom=stranger.test";
	assert.deepEqual(analyzeAuthentication(`${partial}, ${FORGED}`), []);
	// Comments around the sender's authserv-id do not hide the boundary to its forged copy.
	const commentedForgery = "mail.attacker.test (comment); dmarc=pass header.from=bank.test";
	assert.equal(topmostAuthenticationResults(`${partial}, ${commentedForgery}`), partial);
	assert.deepEqual(analyzeAuthentication(`${partial}, ${commentedForgery}`), []);
	assert.deepEqual(analyzeAuthentication(`${partial}, (see notes) mail.attacker.test; dmarc=pass`), []);
	assert.deepEqual(analyzeAuthentication(`${partial}, mail.attacker.test (a (nested) note); dmarc=pass`), []);
	const joinedCommented = new Headers([
		["authentication-results", partial],
		["authentication-results", commentedForgery],
	]).get("authentication-results");
	assert.equal(trustedCloudflareAuthenticationResults(joinedCommented), partial);
	// A quoted authserv-id does not hide the boundary either.
	assert.deepEqual(analyzeAuthentication(`${partial}, "mail.attacker.test"; dmarc=pass`), []);
	// Text in the trusted copy that opens a comment or quote cannot swallow the boundary.
	const opened = 'mx.cloudflare.net; spf=none smtp.mailfrom="a(b"@stranger.test';
	assert.deepEqual(analyzeAuthentication(`${opened}, x) "; dmarc=pass`), []);
	assert.deepEqual(analyzeAuthentication("mx.cloudflare.net; spf=none smtp.mailfrom=a(b@x.test, x); dmarc=pass"), []);
	// A comma inside the trusted copy only drops what follows it.
	const commented =
		"mx.cloudflare.net; dkim=pass header.d=a.test; dmarc=pass (p=NONE, sp=NONE dis=NONE) header.from=a.test";
	assert.equal(
		topmostAuthenticationResults(commented),
		"mx.cloudflare.net; dkim=pass header.d=a.test; dmarc=pass (p=NONE",
	);
	assert.deepEqual(ids(analyzeAuthentication(commented)), ["dkim_passed", "dmarc_passed"]);
});

test("the analyzer counts only what intake vouched for", () => {
	assert.deepEqual(analyzeAuthentication(null), []);
	assert.deepEqual(analyzeAuthentication(undefined), []);
	assert.deepEqual(ids(analyzeAuthentication(FORGED)), ["dkim_passed", "dmarc_passed", "spf_passed"]);
	assert.deepEqual(
		ids(analyzeAuthentication("mx.cloudflare.net; spf=fail smtp.mailfrom=x; dmarc=fail header.from=x")),
		["dmarc_failed", "spf_failed"],
	);
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
			authenticationResults: trustedCloudflareAuthenticationResults(headers["authentication-results"]),
		},
		{},
	);
	assert.equal(queued[0].authenticationResults, CLOUDFLARE);
	assert.ok(!ids(analyzeAuthentication(queued[0].authenticationResults)).includes("dmarc_passed"));
});

function relayRequest(raw, headersJson, { sign = true, tamper = null } = {}) {
	const from = "x@bank.test";
	const to = "owner@example.com";
	const headers = new Headers({ "X-Kite-Headers": tamper ?? headersJson });
	if (sign)
		headers.set(
			"X-Kite-Headers-Signature",
			createHmac("sha256", SECRET)
				.update(`kite-headers\n${from}\n${to}\n${headersJson}\n`)
				.update(new Uint8Array(raw))
				.digest("hex"),
		);
	return readRelayHeaders(SECRET, headers, raw, from, to);
}

test("relay: Authentication-Results counts only with a valid headers signature", async () => {
	const raw = mime([`Authentication-Results: ${FORGED}`]);
	const trusted = JSON.stringify({ "authentication-results": CLOUDFLARE, subject: "Verify your account" });
	assert.equal((await relayRequest(raw, trusted)).authenticationResults, CLOUDFLARE);
	// A relay from before the headers signature: the map is kept, its authentication is not.
	const unsigned = await relayRequest(raw, trusted, { sign: false });
	assert.equal(unsigned.authenticationResults, null);
	assert.equal(unsigned.headers.subject, "Verify your account");
	// A map changed after signing.
	const swapped = JSON.stringify({ "authentication-results": FORGED });
	assert.equal((await relayRequest(raw, trusted, { tamper: swapped })).authenticationResults, null);
	// A signed map whose topmost header is not Cloudflare's.
	const foreign = JSON.stringify({ "authentication-results": `mail.attacker.test; dmarc=pass, ${FORGED}` });
	assert.equal((await relayRequest(raw, foreign)).authenticationResults, null);
	assert.equal((await relayRequest(raw, "not json", { sign: false })).authenticationResults, null);
});

test("SES and Resend: the message's own Authentication-Results never count", async (t) => {
	const { env, queued } = await setup(t);
	const raw = mime([
		"Authentication-Results: amazonses.com; spf=pass; dmarc=none",
		`Authentication-Results: ${FORGED}`,
	]);
	const notification = parseSesNotification(
		JSON.stringify({
			notificationType: "Received",
			mail: {
				source: "x@bank.test",
				destination: ["owner@example.com"],
				headers: [
					{ name: "Authentication-Results", value: "amazonses.com; spf=pass; dmarc=none" },
					{ name: "Authentication-Results", value: FORGED },
				],
			},
			receipt: { recipients: ["owner@example.com"], action: { type: "S3", bucketName: "b", objectKey: "k" } },
		}),
	);
	const ses = await intakeProviderMail(env, {
		from: notification.from,
		recipients: notification.recipients,
		raw,
		headers: notification.headers,
	});
	const resend = await intakeProviderMail(env, { from: "x@bank.test", recipients: ["owner@example.com"], raw });
	assert.equal(ses.delivered + resend.delivered, 2);
	assert.deepEqual(
		queued.map((payload) => payload.authenticationResults),
		[null, null],
	);
});
