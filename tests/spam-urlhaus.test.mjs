import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-spam-urlhaus-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		engine: fileURLToPath(import.meta.resolve("../src/lib/spam/engine.ts")),
		urlhaus: fileURLToPath(import.meta.resolve("../src/lib/spam/providers/urlhaus.ts")),
		facts: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/facts-utils.ts")),
		db: fileURLToPath(import.meta.resolve("../src/db/index.ts")),
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
const { analyzeSpam } = await load("engine");
const { UrlhausIntelligenceProvider, spamIntelligenceProvider, isUrlhausConfigured } = await load("urlhaus");
const { collectFacts } = await load("facts");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

// Invented data only: hosts under .test and a key that is not a real abuse.ch key.
const KEY = "test-auth-key";
const file = (filename, type, text, extra = {}) => ({
	filename,
	type,
	content: new TextEncoder().encode(text).buffer,
	disposition: "attachment",
	contentId: null,
	...extra,
});
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function email(overrides = {}) {
	return {
		subject: "Hello",
		text: "Just checking in.",
		html: null,
		messageId: "<m1@example.test>",
		fromAddr: "Sender <sender@stranger.test>",
		toAddr: "owner@example.com",
		ccAddr: null,
		bccAddr: null,
		inReplyTo: null,
		references: [],
		date: null,
		attachments: [],
		...overrides,
	};
}

/** A fake URLhaus: lists the given URLs and hashes, records every request. */
function fakeUrlhaus({ urls = [], hashes = [], fail = false } = {}) {
	const requests = [];
	const fetcher = async (url, init) => {
		const form = new URLSearchParams(init.body);
		requests.push({ url: String(url), key: init.headers["Auth-Key"], form: Object.fromEntries(form) });
		if (fail === "throw") throw new Error("network down");
		if (fail) return Response.json({ query_status: "ok" }, { status: 503 });
		const listed = urls.includes(form.get("url")) || hashes.includes(form.get("sha256_hash"));
		return Response.json({ query_status: listed ? "ok" : "no_results" });
	};
	return { requests, provider: new UrlhausIntelligenceProvider(KEY, fetcher) };
}

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
	`);
	const db = createDb(sqlite);
	const analyze = (message, provider, headers) =>
		analyzeSpam(db, {
			mailboxId: "mailbox-a",
			userId: "owner",
			envelopeFrom: "bounce@stranger.test",
			headers,
			message,
			intelligenceProvider: provider,
		});
	const addContact = (email, source, blocked = 0) =>
		sqlite.db
			.prepare(
				"INSERT INTO contacts (id, user_id, email, display_name, source, blocked, created_at, last_seen_at) VALUES (?, 'owner', ?, 'Someone', ?, ?, 1, 1)",
			)
			.run(`contact-${email}`, email, source, blocked);
	return { analyze, addContact };
}

const ids = (result) => result.signals.map((signal) => signal.id);
const risky = (link) =>
	email({
		subject: "Invoice 4471",
		text: `Your invoice is ready. Please confirm your password immediately to view it: ${link}`,
		html: `<p>Your invoice is ready. Please confirm your password immediately to view it.</p><a href="${link}">View invoice</a>`,
	});

test("a listed link in a risky message adds the URLhaus signal, sending the key and the link", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	const { provider, requests } = fakeUrlhaus({ urls: [link] });
	const result = await analyze(risky(link), provider);
	assert.ok(ids(result).includes("urlhaus_url"), ids(result).join(", "));
	assert.equal(result.signals.find((signal) => signal.id === "urlhaus_url").score, 40);
	assert.deepEqual(
		requests.map((request) => [request.url, request.key, request.form.url]),
		[["https://urlhaus-api.abuse.ch/v1/url/", KEY, link]],
	);
});

test("links of a message that shows no risk are never sent", async (t) => {
	const { analyze } = await setup(t);
	const { provider, requests } = fakeUrlhaus({ urls: ["https://news.stranger.test/a?token=private"] });
	const result = await analyze(
		email({ text: "Our newsletter: https://news.stranger.test/a?token=private", html: null }),
		provider,
	);
	assert.deepEqual(requests, []);
	assert.ok(!ids(result).includes("urlhaus_url"));
});

test("attachments are looked up by SHA-256 only, inline images not at all", async (t) => {
	const { analyze } = await setup(t);
	const page = "<html><body>Statement</body></html>";
	const { provider, requests } = fakeUrlhaus({ hashes: [sha256(page)] });
	const result = await analyze(
		email({
			attachments: [
				file("statement.html", "text/html", page),
				file("scan.pdf", "application/pdf", "%PDF-1.4"),
				file("logo.png", "image/png", "png", { disposition: "inline", contentId: "<logo>" }),
			],
		}),
		provider,
	);
	assert.ok(ids(result).includes("urlhaus_payload"));
	// Hashing runs concurrently, so the requests may arrive in either order.
	assert.deepEqual(
		requests
			.map((request) => [request.url, request.form])
			.sort((a, b) => a[1].sha256_hash.localeCompare(b[1].sha256_hash)),
		[
			["https://urlhaus-api.abuse.ch/v1/payload/", { sha256_hash: sha256(page) }],
			["https://urlhaus-api.abuse.ch/v1/payload/", { sha256_hash: sha256("%PDF-1.4") }],
		].sort((a, b) => a[1].sha256_hash.localeCompare(b[1].sha256_hash)),
	);
});

test("a message that shows no risk sends nothing, not even attachment hashes", async (t) => {
	const { analyze } = await setup(t);
	const { provider, requests } = fakeUrlhaus();
	await analyze(email({ attachments: [file("minutes.pdf", "application/pdf", "%PDF-1.4 minutes")] }), provider);
	assert.deepEqual(requests, []);
});

test("at most five links and three files are looked up, links inside attachments first", async (t) => {
	const { analyze } = await setup(t);
	const { provider, requests } = fakeUrlhaus();
	const body = Array.from({ length: 8 }, (_, index) => `https://site${index}.stranger.test/x`).join(" ");
	const page = `<a href="https://inside.stranger.test/login">Open</a>`;
	await analyze(
		email({
			subject: "Invoice",
			text: `Please confirm your password: ${body}`,
			attachments: [
				file("invoice.html", "text/html", page),
				...["a", "b", "c"].map((name) => file(`${name}.pdf`, "application/pdf", name)),
			],
		}),
		provider,
	);
	const urls = requests.filter((request) => request.form.url).map((request) => request.form.url);
	assert.equal(urls.length, 5);
	assert.equal(urls[0], "https://inside.stranger.test/login");
	assert.equal(requests.filter((request) => request.form.sha256_hash).length, 3);
});

test("a failing or unreachable URLhaus adds nothing", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	for (const fail of [true, "throw"]) {
		const { provider, requests } = fakeUrlhaus({ urls: [link], fail });
		const result = await analyze(risky(link), provider);
		assert.equal(requests.length, 1);
		assert.ok(!ids(result).some((id) => id.startsWith("urlhaus_")));
	}
});

test("saved and written-to contacts are not looked up unless authentication failed; blocked senders never", async (t) => {
	const { analyze, addContact } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	addContact("friend@stranger.test", "manual");
	addContact("bad@stranger.test", "inbound", 1);
	const { provider, requests } = fakeUrlhaus({ urls: [link] });
	await analyze({ ...risky(link), fromAddr: "Friend <friend@stranger.test>" }, provider);
	await analyze({ ...risky(link), fromAddr: "Bad <bad@stranger.test>" }, provider);
	assert.deepEqual(requests, []);
	const forged = await analyze({ ...risky(link), fromAddr: "Friend <friend@stranger.test>" }, provider, {
		"authentication-results":
			"mx.cloudflare.net; spf=fail smtp.mailfrom=stranger.test; dmarc=fail header.from=stranger.test",
	});
	assert.equal(requests.length, 1, "a forged From of a contact is still checked");
	assert.ok(ids(forged).includes("urlhaus_url"));
});

test("the provider is URLhaus only when URLHAUS_AUTH_KEY is set", () => {
	assert.equal(isUrlhausConfigured({}), false);
	assert.equal(isUrlhausConfigured({ URLHAUS_AUTH_KEY: "  " }), false);
	assert.equal(isUrlhausConfigured({ URLHAUS_AUTH_KEY: KEY }), true);
	assert.ok(spamIntelligenceProvider({ URLHAUS_AUTH_KEY: KEY }) instanceof UrlhausIntelligenceProvider);
	assert.ok(!(spamIntelligenceProvider({}) instanceof UrlhausIntelligenceProvider));
});

test("a URLhaus match becomes a phishing warning reason", () => {
	const facts = collectFacts({
		message: {
			fromAddr: "Sender <sender@stranger.test>",
			subject: "Invoice",
			textBody: "See attached",
			spamVerdict: "suspicious",
			spamSignals: JSON.stringify([
				{ id: "urlhaus_url", score: 40, reason: "x" },
				{ id: "urlhaus_payload", score: 50, reason: "x" },
			]),
		},
	});
	assert.ok(facts.phishingSignals.includes("urlhaus_url"));
	assert.ok(facts.phishingSignals.includes("urlhaus_payload"));
});
