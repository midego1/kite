import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-spam-threat-lookups-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		engine: source("lib/spam/engine.ts"),
		abuseCh: source("lib/spam/providers/abuse-ch.ts"),
		abuseChUtils: source("lib/spam/providers/abuse-ch-utils.ts"),
		threatfoxUtils: source("lib/spam/providers/threatfox-utils.ts"),
		facts: source("lib/agent/auto-read/facts-utils.ts"),
		db: source("db/index.ts"),
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
const { spamIntelligenceProvider, testAbuseChKey } = await load("abuseCh");
const { abuseChAuthKey, keyTestResult, lookupOutcome, lookupSignals } = await load("abuseChUtils");
const { threatfoxHostTerms } = await load("threatfoxUtils");
const { collectFacts } = await load("facts");
const { createDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

// Invented data only: hosts under .test and a key that is not a real abuse.ch key.
const KEY = "test-auth-key";
const URLHAUS = /^https:\/\/urlhaus-api\.abuse\.ch\//;
const THREATFOX = /^https:\/\/threatfox-api\.abuse\.ch\/api\/v1\/$/;
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

/**
 * A fake abuse.ch: URLhaus lists `urls` and `hashes`, ThreatFox lists `hosts` and `threatfoxHashes`.
 * `fail` makes both answer 503 (or throw); `reject` makes both refuse the key. Records every request.
 */
function fakeAbuseCh({ urls = [], hashes = [], hosts = [], threatfoxHashes = [], fail = false, reject = false } = {}) {
	const requests = [];
	const fetcher = async (url, init) => {
		const target = String(url);
		const threatfox = THREATFOX.test(target);
		assert.ok(threatfox || URLHAUS.test(target), target);
		const body = threatfox ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
		requests.push({
			service: threatfox ? "threatfox" : "urlhaus",
			url: target,
			key: init.headers["Auth-Key"],
			contentType: init.headers["Content-Type"],
			body,
		});
		if (fail === "throw") throw new Error("network down");
		if (fail) return Response.json({ query_status: "ok", data: [{ id: "1" }] }, { status: 503 });
		if (reject)
			return threatfox ? Response.json({ query_status: "unknown_auth_key" }) : new Response("", { status: 401 });
		if (threatfox) {
			const listed = hosts.includes(body.search_term) || threatfoxHashes.includes(body.hash);
			return Response.json(
				listed
					? { query_status: "ok", data: [{ id: "41", ioc: body.search_term ?? "x" }] }
					: { query_status: "no_result", data: "Your search did not yield any results" },
			);
		}
		const listed = urls.includes(body.url) || hashes.includes(body.sha256_hash);
		return Response.json({ query_status: listed ? "ok" : "no_results" });
	};
	const of = (service) => requests.filter((request) => request.service === service);
	return { requests, of, fetcher, provider: spamIntelligenceProvider({ URLHAUS_AUTH_KEY: KEY }, fetcher) };
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
const signal = (result, id) => result.signals.find((item) => item.id === id);
const risky = (link) =>
	email({
		subject: "Invoice 4471",
		text: `Your invoice is ready. Please confirm your password immediately to view it: ${link}`,
		html: `<p>Your invoice is ready. Please confirm your password immediately to view it.</p><a href="${link}">View invoice</a>`,
	});

/** Collects the JSON log lines written while `run` runs. */
async function captureWarnings(run) {
	const lines = [];
	const original = console.warn;
	console.warn = (line) => lines.push(String(line));
	try {
		await run();
	} finally {
		console.warn = original;
	}
	return lines;
}

test("a link URLhaus lists adds its signal, sending the key and the link", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	const { provider, of } = fakeAbuseCh({ urls: [link] });
	const result = await analyze(risky(link), provider);
	assert.ok(ids(result).includes("urlhaus_url"), ids(result).join(", "));
	assert.equal(signal(result, "urlhaus_url").score, 40);
	assert.ok(!ids(result).includes("threatfox_url"));
	assert.deepEqual(
		of("urlhaus").map((request) => [request.url, request.key, request.body.url]),
		[["https://urlhaus-api.abuse.ch/v1/url/", KEY, link]],
	);
});

test("ThreatFox is asked about link hosts only, exactly, with the same key", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip?token=private";
	const { provider, of } = fakeAbuseCh({ hosts: ["stranger.test"] });
	const result = await analyze(risky(link), provider);
	assert.deepEqual(
		of("threatfox").map((request) => [request.key, request.contentType, request.body]),
		[
			[KEY, "application/json", { query: "search_ioc", search_term: "files.stranger.test", exact_match: true }],
			[KEY, "application/json", { query: "search_ioc", search_term: "stranger.test", exact_match: true }],
		],
	);
	assert.equal(signal(result, "threatfox_url").score, 40);
	assert.equal(
		signal(result, "threatfox_url").reason,
		"A link goes to a site ThreatFox lists as malware infrastructure",
	);
	assert.ok(!ids(result).includes("urlhaus_url"));
});

test("a link on both lists counts 40 plus 10, not twice in full", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	const { provider } = fakeAbuseCh({ urls: [link], hosts: ["files.stranger.test"] });
	const result = await analyze(risky(link), provider);
	assert.equal(signal(result, "urlhaus_url").score, 40);
	assert.deepEqual(signal(result, "threatfox_url"), {
		id: "threatfox_url",
		score: 10,
		reason: "A link goes to a site ThreatFox lists as malware infrastructure",
		metadata: { count: 1, alsoOnUrlhaus: true },
	});
});

for (const [name, links, listedUrls, hosts, score] of [
	[
		"unrelated links on different lists keep both full scores",
		["https://one.test/a", "https://two.test/b"],
		["https://one.test/a"],
		["two.test"],
		40,
	],
	[
		"a ThreatFox host keeps every associated URL, not just the URLhaus match",
		["https://files.stranger.test/a", "https://files.stranger.test/b"],
		["https://files.stranger.test/a"],
		["files.stranger.test"],
		40,
	],
	[
		"a ThreatFox parent domain keeps URLs from every matching subdomain",
		["https://one.stranger.test/a", "https://two.stranger.test/b"],
		["https://one.stranger.test/a"],
		["stranger.test"],
		40,
	],
	[
		"a ThreatFox parent is discounted when URLhaus lists every associated URL",
		["https://one.stranger.test/a", "https://two.stranger.test/b"],
		["https://one.stranger.test/a", "https://two.stranger.test/b"],
		["stranger.test"],
		10,
	],
	[
		"an overlapping link does not discount another ThreatFox-only link",
		["https://one.test/a", "https://two.test/b"],
		["https://one.test/a"],
		["one.test", "two.test"],
		40,
	],
	[
		"an IPv4 host and port retains each associated URL",
		["https://192.0.2.10:8443/a", "https://192.0.2.10:8443/b"],
		["https://192.0.2.10:8443/b"],
		["192.0.2.10:8443"],
		40,
	],
	[
		"IPv4 links on different ports are separate inputs",
		["https://192.0.2.10/a", "https://192.0.2.10:8443/a"],
		["https://192.0.2.10/a"],
		["192.0.2.10:8443"],
		40,
	],
	[
		"an IPv4 match on the same URL gets the second-list discount",
		["https://192.0.2.10/a"],
		["https://192.0.2.10/a"],
		["192.0.2.10:443"],
		10,
	],
]) {
	test(name, async (t) => {
		const { analyze } = await setup(t);
		const { provider } = fakeAbuseCh({ urls: listedUrls, hosts });
		const result = await analyze(
			email({ text: `Please confirm your password immediately: ${links.join(" ")}` }),
			provider,
		);
		assert.equal(signal(result, "urlhaus_url").score, 40);
		assert.equal(signal(result, "threatfox_url").score, score);
		assert.equal(signal(result, "threatfox_url").metadata.alsoOnUrlhaus, score === 10 ? true : undefined);
	});
}

test("links of a message that shows no risk are never sent", async (t) => {
	const { analyze } = await setup(t);
	const { provider, requests } = fakeAbuseCh({ urls: ["https://news.stranger.test/a?token=private"] });
	const result = await analyze(
		email({ text: "Our newsletter: https://news.stranger.test/a?token=private", html: null }),
		provider,
	);
	assert.deepEqual(requests, []);
	assert.ok(!ids(result).some((id) => id.startsWith("urlhaus_") || id.startsWith("threatfox_")));
});

test("HTML body and attachment links are entity-decoded before the URLhaus lookup", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.bad.test/get?a=1&b=2";
	for (const escaped of [
		"https://files.bad.test/get?a=1&amp;b=2",
		"https://files.bad.test/get?a=1&#38;b=2",
		"https&#58;//files.bad.test/get?a=1&#x26;b=2",
	]) {
		const html = `<p>Please confirm your password immediately.</p><a href="${escaped}">View file</a>`;
		for (const message of [{ text: null, html }, { attachments: [file("file.html", "text/html", html)] }]) {
			const { provider, of } = fakeAbuseCh({ urls: [link] });
			const result = await analyze(email(message), provider);
			assert.ok(ids(result).includes("urlhaus_url"), `${JSON.stringify(message)}: ${ids(result)}`);
			assert.deepEqual(
				of("urlhaus")
					.filter((request) => request.body.url)
					.map((request) => request.body.url),
				[link],
			);
		}
	}
});

test("plain-text lookup URLs keep literal HTML entity spellings", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.bad.test/get?a=1&amp;b=2";
	const { provider, of } = fakeAbuseCh({ urls: [link] });
	const result = await analyze(
		email({ text: `Please confirm your password immediately: ${link}`, html: null }),
		provider,
	);
	assert.ok(ids(result).includes("urlhaus_url"));
	assert.deepEqual(
		of("urlhaus").map((request) => request.body.url),
		[link],
	);
});

test("attachments are looked up by SHA-256 only, on both lists, inline images not at all", async (t) => {
	const { analyze } = await setup(t);
	const page = "<html><body>Statement</body></html>";
	const { provider, of } = fakeAbuseCh({ hashes: [sha256(page)], threatfoxHashes: [sha256(page)] });
	const result = await analyze(
		email({
			attachments: [
				file("statement.html", "text/html", page),
				file("scan.pdf", "application/pdf", "%PDF-1.4"),
				file("copy.pdf", "application/pdf", "%PDF-1.4"),
				file("logo.png", "image/png", "png", { disposition: "inline", contentId: "<logo>" }),
			],
		}),
		provider,
	);
	assert.equal(signal(result, "urlhaus_payload").score, 50);
	assert.equal(signal(result, "threatfox_payload").score, 10, "the second list adds only a little");
	const expected = [sha256(page), sha256("%PDF-1.4")];
	assert.deepEqual(
		of("urlhaus").map((request) => [request.url, request.body]),
		expected.map((hash) => ["https://urlhaus-api.abuse.ch/v1/payload/", { sha256_hash: hash }]),
	);
	assert.deepEqual(
		of("threatfox").map((request) => request.body),
		expected.map((hash) => ({ query: "search_hash", hash })),
		"an identical attachment is looked up once",
	);
});

test("an attachment only ThreatFox knows adds 50", async (t) => {
	const { analyze } = await setup(t);
	const program = "MZ fake program";
	const { provider } = fakeAbuseCh({ threatfoxHashes: [sha256(program)] });
	const result = await analyze(
		email({ attachments: [file("setup.exe", "application/octet-stream", program)] }),
		provider,
	);
	assert.equal(signal(result, "threatfox_payload").score, 50);
	assert.equal(signal(result, "threatfox_payload").reason, "An attachment matches malware known to ThreatFox");
	assert.ok(!ids(result).includes("urlhaus_payload"));
});

test("different attachment hashes on each list keep their full scores, even with an overlap", async (t) => {
	const { analyze } = await setup(t);
	const attachments = [
		file("first.exe", "application/octet-stream", "first program"),
		file("second.exe", "application/octet-stream", "second program"),
	];
	for (const hashes of [[sha256("first program")], [sha256("first program"), sha256("second program")]]) {
		const { provider } = fakeAbuseCh({ hashes, threatfoxHashes: [sha256("second program")] });
		const result = await analyze(email({ attachments }), provider);
		assert.equal(signal(result, "urlhaus_payload").score, 50);
		assert.equal(signal(result, "threatfox_payload").score, hashes.length === 1 ? 50 : 10);
	}
	const { provider } = fakeAbuseCh({
		hashes: [sha256("first program")],
		threatfoxHashes: [sha256("first program"), sha256("second program")],
	});
	const result = await analyze(email({ attachments }), provider);
	assert.equal(signal(result, "threatfox_payload").score, 50);
	assert.equal(signal(result, "threatfox_payload").metadata.alsoOnUrlhaus, undefined);
});

test("a message that shows no risk sends nothing, not even attachment hashes", async (t) => {
	const { analyze } = await setup(t);
	const { provider, requests } = fakeAbuseCh();
	await analyze(email({ attachments: [file("minutes.pdf", "application/pdf", "%PDF-1.4 minutes")] }), provider);
	assert.deepEqual(requests, []);
});

test("at most five links, five hosts and three files are looked up, links inside attachments first", async (t) => {
	const { analyze } = await setup(t);
	const { provider, of } = fakeAbuseCh();
	const body = Array.from({ length: 8 }, (_, index) => `https://site${index}.stranger.test/x?id=${index}`).join(" ");
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
	const urls = of("urlhaus")
		.filter((request) => request.body.url)
		.map((request) => request.body.url);
	assert.equal(urls.length, 5);
	assert.equal(urls[0], "https://inside.stranger.test/login");
	assert.equal(of("urlhaus").filter((request) => request.body.sha256_hash).length, 3);
	const terms = of("threatfox")
		.filter((request) => request.body.query === "search_ioc")
		.map((request) => request.body.search_term);
	assert.deepEqual(terms, [
		"inside.stranger.test",
		"site0.stranger.test",
		"site1.stranger.test",
		"site2.stranger.test",
		"site3.stranger.test",
	]);
	assert.equal(of("threatfox").filter((request) => request.body.query === "search_hash").length, 3);
});

test("ThreatFox host terms: IPv4 with the link's port, parents after hosts, no IPv6 or paths", () => {
	assert.deepEqual(
		threatfoxHostTerms([
			"http://192.0.2.10/a",
			"https://198.51.100.7:8443/b",
			"https://[2001:db8::1]/c",
			"https://www.login.bad.co.uk/d?x=1",
			"https://bad.co.uk/e",
			"not a url",
		]),
		["192.0.2.10:80", "198.51.100.7:8443", "www.login.bad.co.uk", "bad.co.uk"],
	);
	assert.deepEqual(threatfoxHostTerms(["https://evil.github.io/x"]), ["evil.github.io"]);
});

test("a failing or unreachable abuse.ch adds nothing", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	for (const fail of [true, "throw"]) {
		const { provider, of } = fakeAbuseCh({ urls: [link], hosts: ["files.stranger.test"], fail });
		const result = await analyze(risky(link), provider);
		assert.equal(of("urlhaus").length, 1);
		assert.equal(of("threatfox").length, 2);
		assert.ok(!ids(result).some((id) => id.startsWith("urlhaus_") || id.startsWith("threatfox_")));
	}
});

test("a refused key is logged once per service, without the key or the links", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	const { provider } = fakeAbuseCh({ reject: true });
	let result;
	const lines = await captureWarnings(async () => {
		result = await analyze(risky(link), provider);
	});
	assert.ok(!ids(result).some((id) => id.startsWith("urlhaus_") || id.startsWith("threatfox_")));
	const events = lines.map((line) => JSON.parse(line));
	assert.deepEqual(
		events.map((event) => [event.level, event.component, event.event, event.fields]),
		[
			["warn", "spam", "spam.threat_lookup_key_rejected", { service: "urlhaus", source: "mail" }],
			["warn", "spam", "spam.threat_lookup_key_rejected", { service: "threatfox", source: "mail" }],
		],
	);
	for (const line of lines) {
		assert.ok(!line.includes(KEY));
		assert.ok(!/stranger\.test/.test(line));
	}
});

test("saved and written-to contacts are not looked up unless authentication failed; blocked senders never", async (t) => {
	const { analyze, addContact } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	addContact("friend@stranger.test", "manual");
	addContact("bad@stranger.test", "inbound", 1);
	const { provider, requests, of } = fakeAbuseCh({ urls: [link], hosts: ["files.stranger.test"] });
	await analyze({ ...risky(link), fromAddr: "Friend <friend@stranger.test>" }, provider);
	await analyze({ ...risky(link), fromAddr: "Bad <bad@stranger.test>" }, provider);
	assert.deepEqual(requests, []);
	const forged = await analyze({ ...risky(link), fromAddr: "Friend <friend@stranger.test>" }, provider, {
		"authentication-results":
			"mx.cloudflare.net; spf=fail smtp.mailfrom=stranger.test; dmarc=fail header.from=stranger.test",
	});
	assert.equal(of("urlhaus").length, 1, "a forged From of a contact is still checked");
	assert.equal(of("threatfox").length, 2);
	assert.ok(ids(forged).includes("urlhaus_url"));
	assert.ok(ids(forged).includes("threatfox_url"));
});

test("the key comes from URLHAUS_AUTH_KEY, or ABUSE_CH_AUTH_KEY when that is unset", () => {
	assert.equal(abuseChAuthKey({}), null);
	assert.equal(abuseChAuthKey({ URLHAUS_AUTH_KEY: "  " }), null);
	assert.equal(abuseChAuthKey({ URLHAUS_AUTH_KEY: KEY }), KEY);
	assert.equal(abuseChAuthKey({ ABUSE_CH_AUTH_KEY: " alias " }), "alias");
	assert.equal(abuseChAuthKey({ URLHAUS_AUTH_KEY: KEY, ABUSE_CH_AUTH_KEY: "alias" }), KEY);
	assert.equal(abuseChAuthKey({ URLHAUS_AUTH_KEY: " ", ABUSE_CH_AUTH_KEY: "alias" }), "alias");
});

test("lookups run only when a key is set", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	for (const [env, looksUp] of [
		[{ URLHAUS_AUTH_KEY: KEY }, true],
		[{ ABUSE_CH_AUTH_KEY: KEY }, true],
		[{}, false],
	]) {
		const { fetcher, requests } = fakeAbuseCh();
		await analyze(risky(link), spamIntelligenceProvider(env, fetcher));
		assert.equal(requests.length > 0, looksUp, JSON.stringify(env));
	}
});

test("answers map to listed, not listed, a refused key or a failure", () => {
	const listed = (answer) => answer?.query_status === "ok";
	assert.equal(lookupOutcome(200, { query_status: "ok" }, listed), "listed");
	assert.equal(lookupOutcome(200, { query_status: "no_results" }, listed), "not_listed");
	assert.equal(lookupOutcome(200, null, listed), "not_listed");
	assert.equal(lookupOutcome(401, null, listed), "key_rejected");
	assert.equal(lookupOutcome(403, { query_status: "ok" }, listed), "key_rejected");
	assert.equal(lookupOutcome(200, { query_status: "unknown_auth_key" }, listed), "key_rejected");
	assert.equal(lookupOutcome(200, { query_status: "illegal_auth_key" }, listed), "key_rejected");
	assert.equal(lookupOutcome(500, { query_status: "ok" }, listed), "failed");
	assert.equal(lookupOutcome(429, null, listed), "failed");
	assert.deepEqual(["listed", "not_listed", "key_rejected", "failed"].map(keyTestResult), [
		"works",
		"works",
		"rejected",
		"unreachable",
	]);
	assert.deepEqual(lookupSignals([{ service: "threatfox", kind: "link", inputs: [], outcome: "key_rejected" }]), []);
});

test("an empty ThreatFox answer is not a match", async (t) => {
	const { analyze } = await setup(t);
	const link = "https://files.stranger.test/invoice.zip";
	const fetcher = async (url) =>
		Response.json(THREATFOX.test(String(url)) ? { query_status: "ok", data: [] } : { query_status: "no_results" });
	const result = await analyze(risky(link), spamIntelligenceProvider({ URLHAUS_AUTH_KEY: KEY }, fetcher));
	assert.ok(!ids(result).includes("threatfox_url"));
});

test("Test key does one harmless lookup per service and reports each", async () => {
	const { fetcher, requests } = fakeAbuseCh();
	assert.deepEqual(await testAbuseChKey(KEY, fetcher), { urlhaus: "works", threatfox: "works" });
	assert.deepEqual(
		requests.map((request) => [request.service, request.key, request.body]),
		[
			["urlhaus", KEY, { url: "http://example.com/" }],
			["threatfox", KEY, { query: "search_ioc", search_term: "example.com", exact_match: true }],
		],
	);
	const rejected = fakeAbuseCh({ reject: true });
	const lines = await captureWarnings(async () => {
		assert.deepEqual(await testAbuseChKey(KEY, rejected.fetcher), { urlhaus: "rejected", threatfox: "rejected" });
	});
	assert.deepEqual(
		lines.map((line) => JSON.parse(line).fields),
		[
			{ service: "urlhaus", source: "key_test" },
			{ service: "threatfox", source: "key_test" },
		],
	);
	for (const fail of [true, "throw"])
		assert.deepEqual(await testAbuseChKey(KEY, fakeAbuseCh({ fail }).fetcher), {
			urlhaus: "unreachable",
			threatfox: "unreachable",
		});
});

test("URLhaus and ThreatFox matches become phishing warning reasons", () => {
	const facts = collectFacts({
		message: {
			fromAddr: "Sender <sender@stranger.test>",
			subject: "Invoice",
			textBody: "See attached",
			spamVerdict: "suspicious",
			spamSignals: JSON.stringify([
				{ id: "urlhaus_url", score: 40, reason: "x" },
				{ id: "urlhaus_payload", score: 50, reason: "x" },
				{ id: "threatfox_url", score: 40, reason: "x" },
				{ id: "threatfox_payload", score: 50, reason: "x" },
			]),
		},
	});
	for (const id of ["urlhaus_url", "urlhaus_payload", "threatfox_url", "threatfox_payload"])
		assert.ok(facts.phishingSignals.includes(id), id);
});
