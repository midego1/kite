import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Inbound storage bounds (Mailflare #217, #219, #224): stored fields, offloaded HTML, raw objects nothing references
// and the edge's no-route answer, against the self-hosted database and file bucket.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-inbound-storage-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/** Automatic reading is not under test here; the real scheduler would pull in the whole agent. */
const stubAgentSchedule = {
	name: "stub-agent-schedule",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/agent\/auto-read\/schedule$/ }, (args) => ({
			path: args.path,
			namespace: "stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export async function scheduleAgentWork() {}",
			loader: "js",
		}));
	},
};

await build({
	entryPoints: {
		inbound: join(root, "src/lib/email/inbound.ts"),
		incoming: join(root, "src/lib/email/incoming.ts"),
		intake: join(root, "src/lib/email/intake.ts"),
		contacts: join(root, "src/lib/contacts/service.ts"),
		limits: join(root, "src/lib/email/inbound-limits.ts"),
		headers: join(root, "src/lib/email/provider-headers-utils.ts"),
		sweeper: join(root, "src/lib/email/raw-sweeper.ts"),
		sweeperUtils: join(root, "src/lib/email/raw-sweeper-utils.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		bucket: join(root, "server/runtime/file-bucket.ts"),
		queue: join(root, "server/runtime/queue.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	plugins: [stubAgentSchedule],
	alias: {
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processInboundMessage } = await load("inbound");
const { resolveIncomingMail, NO_ROUTE } = await load("incoming");
const { intakeIncomingMail } = await load("intake");
const { upsertContactFromAddress } = await load("contacts");
const limits = await load("limits");
const { readProviderHeaderMap } = await load("headers");
const { sweepOrphanedRawMail } = await load("sweeper");
const sweeperUtils = await load("sweeperUtils");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { FileBucket } = await load("bucket");
const { ensureQueueTable } = await load("queue");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
// A new contact is looked up on Gravatar; nothing leaves the test.
globalThis.fetch = async () => new Response("", { status: 404 });
// Delivery logs what it drops; keep the test output readable.
for (const level of ["info", "warn", "error"]) console[level] = () => {};

const encoder = new TextEncoder();
const DAY = 24 * 60 * 60 * 1000;

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	const directory = mkdtempSync(join(tmpdir(), "kite-inbound-storage-bucket-"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_field, match_operator, action, reject_reason, priority, created_at)
			VALUES ('rule-1', 'owner', 'domain-1', 'domain', 'blocked@example.com', 'recipient', 'exact', 'reject', 'Go away', 10, 1);
	`);
	const bucket = new FileBucket(directory);
	const env = { DB: database, BUCKET: bucket };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const put = async (key, text) => {
		await bucket.put(key, encoder.encode(text));
		return key;
	};
	const exists = async (key) => (await bucket.head(key)) !== null;
	const row = (sql, ...params) => database.db.prepare(sql).get(...params);
	return { database, env, bucket, put, exists, row };
}

const message = (headers, body = "Hello there") =>
	`From: Sender <sender@partner.test>\r\nTo: a@example.com\r\nSubject: Hi\r\n${headers}\r\n${body}\r\n`;

const empty = {
	subject: null,
	text: null,
	html: null,
	messageId: null,
	fromAddr: null,
	toAddr: null,
	ccAddr: null,
	bccAddr: null,
	replyTo: null,
	inReplyTo: null,
	references: [],
	date: null,
	attachments: [],
};

test("stored fields are cut without leaving half a character", () => {
	const subject = `${"a".repeat(997)}😀`;
	assert.equal(subject.length, 999);
	const capped = limits.capChars(subject, 998);
	assert.equal(capped.length, 997);
	assert.doesNotMatch(capped, /[\ud800-\udbff]$/);
	assert.equal(limits.capChars("short", 998), "short");
	assert.equal(limits.capChars(null, 5), null);
	// Three bytes a character, and a cut that would land inside one.
	const text = limits.boundParsedEmail({ ...empty, text: `a${"日".repeat(200_000)}` }).text;
	const bytes = encoder.encode(text);
	assert.ok(bytes.byteLength <= 450_000 && bytes.byteLength > 449_990);
	assert.doesNotMatch(new TextDecoder().decode(bytes), /\uFFFD/);
	assert.equal(limits.boundParsedEmail({ ...empty, text: "abc" }).text, "abc");
});

test("boundParsedEmail keeps oversized fields insertable", () => {
	const fields = {
		subject: "s".repeat(5000),
		text: "t".repeat(2_000_000),
		html: "h".repeat(3_000_000),
		messageId: `<${"m".repeat(5000)}@x>`,
		fromAddr: `${"f".repeat(1200)}@example.com`,
		toAddr: Array.from({ length: 500 }, (_, index) => `person${index}@example.com`).join(", "),
		ccAddr: "x".repeat(9000),
		bccAddr: null,
		replyTo: null,
		inReplyTo: `<${"r".repeat(600)}@x>`,
		references: ["<ok@x>", `<${"r".repeat(600)}@x>`, ...Array.from({ length: 30 }, (_, index) => `<r${index}@x>`)],
		date: null,
		attachments: [],
	};
	const parsed = limits.boundParsedEmail(fields);
	assert.equal(parsed.subject.length, 998);
	assert.ok(encoder.encode(parsed.text).byteLength <= 450_000);
	assert.ok(encoder.encode(parsed.html).byteLength <= 900_000);
	assert.equal(parsed.messageId, null);
	assert.equal(parsed.inReplyTo, null);
	assert.equal(parsed.fromAddr, null, "an over-long From falls back to the envelope sender");
	assert.ok(parsed.toAddr.length <= 8000);
	assert.match(parsed.toAddr, /@example\.com$/, "the list ends on a whole address");
	assert.equal(parsed.ccAddr, null, "a list with no whole address in the limit is dropped");
	assert.equal(parsed.references.length, 20);
	assert.equal(parsed.references.at(-1), "<r29@x>", "the newest references are kept");
	assert.equal(limits.boundParsedEmail(fields, { offloadHtml: true }).html.length, 3_000_000);
});

test("a delivered message with huge fields is stored, its HTML offloaded to the Mail store", async (t) => {
	const { env, put, exists, row } = await setup(t);
	const html = `<html><body>${"<p>Lots of words here.</p>".repeat(60_000)}</body></html>`;
	const raw = [
		"From: " + `${"f".repeat(400)}@partner.test`,
		"To: a@example.com",
		`Subject: ${"s".repeat(3000)}`,
		`Message-ID: <${"m".repeat(5000)}@partner.test>`,
		'Content-Type: multipart/alternative; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"t".repeat(78).concat("\r\n").repeat(30_000),
		"--b",
		"Content-Type: text/html",
		"",
		html,
		"--b--",
		"",
	].join("\r\n");
	const rawR2Key = await put(`inbound/${Date.now()}-big.eml`, raw);
	await processInboundMessage(env, { from: "bounce@partner.test", to: "a@example.com", rawR2Key });
	const stored = row(
		"SELECT id, subject, provider_message_id, length(text_body) AS text, html_body, html_body_key FROM messages WHERE raw_r2_key = ?",
		rawR2Key,
	);
	assert.ok(stored, "the message was stored");
	assert.equal(stored.subject.length, 998);
	assert.equal(stored.provider_message_id, null);
	assert.ok(stored.text <= 450_000);
	assert.equal(stored.html_body, null);
	assert.equal(stored.html_body_key, `bodies/${stored.id}.html`);
	assert.ok(await exists(stored.html_body_key), "the HTML body is in the Mail store");
	assert.ok(await exists(rawR2Key), "the raw message is kept");
	assert.ok(row("SELECT 1 FROM contacts WHERE user_id = 'owner'"), "the sender became a contact");
});

test("a message that cannot be parsed is dropped once, without a retry", async (t) => {
	const { env, put, exists, row } = await setup(t);
	const rawR2Key = await put(`inbound/${Date.now()}-bomb.eml`, message("", "a\r\n".repeat(100_000)));
	await processInboundMessage(env, { from: "x@partner.test", to: "a@example.com", rawR2Key });
	assert.equal(await exists(rawR2Key), false);
	assert.equal(row("SELECT count(*) AS count FROM messages").count, 0);
});

test("raw objects are deleted on the paths that store nothing, and kept when a message names them", async (t) => {
	const { env, database, put, exists } = await setup(t);
	const cases = [
		["nobody@example.com", "no route"],
		["blocked@example.com", "reject rule"],
		["a@unknown.test", "unknown domain"],
	];
	for (const [to, reason] of cases) {
		const rawR2Key = await put(`inbound/${Date.now()}-${reason.replaceAll(" ", "-")}.eml`, message(""));
		await processInboundMessage(env, { from: "x@partner.test", to, rawR2Key });
		assert.equal(await exists(rawR2Key), false, reason);
	}
	// An earlier delivery stored this one before its mailbox was disabled: the message keeps its raw object.
	const shared = await put(`inbound/${Date.now()}-shared.eml`, message(""));
	database.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, raw_r2_key, created_at) VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@partner.test', 'a@example.com', 'received', ?, 1)",
		)
		.run(shared);
	database.db.exec("UPDATE mailboxes SET disabled = 1");
	await processInboundMessage(env, { from: "x@partner.test", to: "a@example.com", rawR2Key: shared });
	assert.equal(await exists(shared), true);
});

test("a failed routing lookup keeps the raw object for the retry", async (t) => {
	const { env, put, exists } = await setup(t);
	const rawR2Key = await put(`inbound/${Date.now()}-retry.eml`, message(""));
	const broken = {
		...env,
		DB: { prepare: () => ({ bind: () => broken.DB.prepare(), all: fail, raw: fail, run: fail, first: fail }) },
	};
	async function fail() {
		throw new Error("D1 is down");
	}
	await assert.rejects(() => processInboundMessage(broken, { from: "x@partner.test", to: "a@example.com", rawR2Key }));
	assert.equal(await exists(rawR2Key), true);
	assert.equal(
		await resolveIncomingMail(broken, "x@partner.test", "a@example.com"),
		null,
		"a failed lookup is not a miss",
	);
});

test("intake refuses an address nothing routes and stores nothing, but stores real mail", async (t) => {
	const { env, bucket } = await setup(t);
	const sent = [];
	env.INBOUND_QUEUE = { send: async (body) => sent.push(body) };
	assert.equal(await resolveIncomingMail(env, "x@partner.test", "nobody@example.com"), NO_ROUTE);
	const rejected = [];
	const input = { from: "x@partner.test", raw: encoder.encode(message("")).buffer, headers: {} };
	const miss = await intakeIncomingMail(
		env,
		{ ...input, to: "nobody@example.com" },
		{ reject: (reason) => rejected.push(reason) },
	);
	assert.deepEqual(miss, { action: "reject", reason: "No such recipient here" });
	assert.deepEqual(rejected, ["No such recipient here"]);
	assert.equal((await bucket.list({ prefix: "inbound/" })).objects.length, 0);
	assert.equal(sent.length, 0);
	const hit = await intakeIncomingMail(env, { ...input, to: "a@example.com" }, {});
	assert.equal(hit.action, "store");
	assert.equal(sent.length, 1);
});

test("two first messages from one sender at once both get the contact", async (t) => {
	const { env, row } = await setup(t);
	const input = { userId: "owner", address: "New Sender <new@partner.test>", source: "inbound" };
	const [first, second] = await Promise.all([
		upsertContactFromAddress(env, input),
		upsertContactFromAddress(env, input),
	]);
	assert.equal(first.email, "new@partner.test");
	assert.equal(second.id, first.id);
	assert.equal(row("SELECT count(*) AS count FROM contacts").count, 1);
});

test("the provider header map is bounded and carries no verification claims", () => {
	const raw = encoder.encode(
		[
			"Authentication-Results: mx.example; dmarc=pass",
			"ARC-Authentication-Results: i=1; mx.example; dmarc=pass",
			"Received: from somewhere",
			"Received-SPF: pass",
			"Return-Path: <x@partner.test>",
			"X-SES-Spam-Verdict: PASS",
			"Auto-Submitted: auto-replied",
			"Precedence: bulk",
			"List-Id: <list.partner.test>",
			`X-Long: ${"v".repeat(5000)}`,
			"Precedence: second",
			...Array.from({ length: 300 }, (_, index) => `X-Pad-${index}: ${index}`),
			"",
			"body",
		].join("\r\n"),
	).buffer;
	const map = readProviderHeaderMap(raw);
	for (const name of [
		"authentication-results",
		"arc-authentication-results",
		"received",
		"received-spf",
		"return-path",
		"x-ses-spam-verdict",
	])
		assert.equal(map[name], undefined, name);
	assert.equal(map["auto-submitted"], "auto-replied");
	assert.equal(map.precedence, "bulk", "the first value wins");
	assert.equal(map["list-id"], "<list.partner.test>");
	assert.equal(map["x-long"].length, 2000);
	assert.equal(Object.keys(map).length, 200);
});

test("dueRawObjects stops at the first object that is not a day old", () => {
	const now = new Date(10 * DAY);
	const object = (key, age) => ({ key, uploaded: new Date(now.getTime() - age) });
	assert.deepEqual(
		sweeperUtils.dueRawObjects(
			[object("inbound/1-a.eml", 2 * DAY), object("inbound/2-b.eml", DAY - 1), object("inbound/3-c.eml", 2 * DAY)],
			now,
		),
		{ due: ["inbound/1-a.eml"], reachedYoung: true },
	);
	assert.deepEqual(sweeperUtils.dueRawObjects([object("inbound/1-a.eml", DAY)], now), {
		due: ["inbound/1-a.eml"],
		reachedYoung: false,
	});
	assert.equal(sweeperUtils.parseRawSweepState('{"version":1,"after":"inbound/1-a.eml"}').after, "inbound/1-a.eml");
	for (const text of [null, "nope", '{"version":2,"after":"inbound/x"}', '{"version":1,"after":"drafts/x"}'])
		assert.equal(sweeperUtils.parseRawSweepState(text), null);
	assert.deepEqual(sweeperUtils.queuedRawKeys('{"from":"a","rawR2Key":"inbound/1-a.eml","to":"b"}'), [
		"inbound/1-a.eml",
	]);
	assert.deepEqual(sweeperUtils.queuedRawKeys('{"rawR2Key":"external/x/1/2.eml"}'), []);
});

test("the sweeper deletes only day-old inbound objects nothing references, and resumes where it stopped", async (t) => {
	const { env, database, put, exists } = await setup(t);
	const keys = [];
	for (let index = 0; index < 7; index++)
		keys.push(await put(`inbound/${1_000_000 + index}-k${index}.eml`, message("")));
	const other = await put("drafts/d1.eml", "draft");
	database.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, raw_r2_key, created_at) VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@partner.test', 'a@example.com', 'received', ?, 1)",
		)
		.run(keys[1]);
	ensureQueueTable(database.db);
	database.db
		.prepare(
			"INSERT INTO node_queue_messages (queue, body, attempts, available_at, created_at) VALUES ('inbound', ?, 0, 0, 0)",
		)
		.run(JSON.stringify({ from: "x", to: "y", rawR2Key: keys[2] }));
	const later = new Date(Date.now() + 2 * DAY);

	const first = await sweepOrphanedRawMail(env, later, { pageSize: 2, maxPages: 2 });
	assert.deepEqual(first, { skipped: null, scanned: 4, removed: 2, after: keys[3] });
	assert.deepEqual(
		await Promise.all(keys.map(exists)),
		[false, true, true, false, true, true, true],
		"a referenced object and one a pending queue message names are kept",
	);
	const second = await sweepOrphanedRawMail(env, later, { pageSize: 2, maxPages: 5 });
	assert.deepEqual(second, { skipped: null, scanned: 3, removed: 3, after: keys[6] });
	assert.equal(await exists(other), true, "only inbound/ is swept");
	const young = await put(`inbound/${Date.now() + 1}-young.eml`, message(""));
	assert.deepEqual(await sweepOrphanedRawMail(env, new Date()), {
		skipped: null,
		scanned: 0,
		removed: 0,
		after: keys[6],
	});
	assert.equal(await exists(young), true, "an object less than a day old is kept");
});

test("the sweeper waits while a Mail storage migration or a restore runs", async (t) => {
	const { env, database, bucket, put, exists } = await setup(t);
	const key = await put("inbound/1-orphan.eml", message(""));
	const later = new Date(Date.now() + 2 * DAY);
	database.db.exec(`
		INSERT INTO storage_migrations (id, object_class, from_store_id, to_store_id, status, created_at)
			VALUES ('job-1', 'mail', 'default', 'store-1', 'copying', 1);
	`);
	assert.deepEqual(await sweepOrphanedRawMail(env, later), { skipped: "storage_migration" });
	database.db.exec("UPDATE storage_migrations SET status = 'completed'");
	await bucket.put("system/backup-restore.json", JSON.stringify({ status: "restoring" }));
	assert.deepEqual(await sweepOrphanedRawMail(env, later), { skipped: "restore" });
	assert.equal(await exists(key), true);
	await bucket.put("system/backup-restore.json", JSON.stringify({ status: "completed" }));
	assert.equal((await sweepOrphanedRawMail(env, later)).removed, 1);
	assert.equal(await exists(key), false);
});
