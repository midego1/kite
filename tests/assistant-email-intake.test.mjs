import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Invented mail only.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-assistant-email-intake-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/** `recoverAgentWork`'s delivery path pulls in automatic-reading scheduling this test never exercises. */
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
		emailInbound: join(root, "src/lib/email/inbound.ts"),
		routing: join(root, "src/lib/email/routing.ts"),
		process: join(root, "src/lib/agent/email/process.ts"),
		userAiSettings: join(root, "src/lib/agent/user-ai-settings.ts"),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		bucket: join(root, "server/runtime/file-bucket.ts"),
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
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processInboundMessage } = await load("emailInbound");
const { resolveInboundAddress, isAssistantAddressTaken } = await load("routing");
const { processAssistantEmailRequest } = await load("process");
const { readUserAiSettings } = await load("userAiSettings");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { FileBucket } = await load("bucket");

const tmp = () => mkdtempSync(join(tmpdir(), "kite-assistant-email-raw-"));

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'owner', 1);
		INSERT INTO assistant_addresses (id, domain_id, local_part, enabled, created_at) VALUES ('asa-1', 'domain-1', 'assistant', 1, 1);
		INSERT INTO user_ai_settings (user_id, assistant_email_enabled, assistant_email_daily_limit, updated_at) VALUES ('owner', 1, 20, 1);
	`);
	const directory = tmp();
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const bucket = new FileBucket(directory);
	const queued = [];
	const env = { DB: database, BUCKET: bucket, AGENT_QUEUE: { send: async (message) => void queued.push(message) } };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { database, env, db: getDb(env), bucket, queued };
}

const DMARC_PASS =
	"mx.cloudflare.net; spf=none smtp.mailfrom=owner.test; dkim=none; dmarc=pass header.from=example.com";
const DMARC_FAIL =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.com; dkim=none; dmarc=fail header.from=example.com";

const DEFAULT_MAIL = {
	from: "Owner <owner@example.com>",
	to: "assistant@example.com",
	subject: "What did Jan say about the roof quote?",
	messageId: "<req-1@example.com>",
};

function mime(fields, extra) {
	const lines = [
		`From: ${fields.from}`,
		`To: ${fields.to}`,
		`Subject: ${fields.subject}`,
		`Message-ID: ${fields.messageId}`,
		`Date: ${fields.date}`,
	];
	for (const [name, value] of Object.entries(extra)) lines.push(`${name}: ${value}`);
	return new TextEncoder().encode([...lines, "", "Hello"].join("\r\n")).buffer;
}

/**
 * `payload.headers` is what the Worker's `email` handler captures from `message.headers` (always lower-cased
 * keys), a path separate from the raw MIME bytes; the guards read only this map, so a header a test wants
 * them to see must go here too, not just into the raw message text.
 */
async function deliver(env, options = {}) {
	// A default parameter only applies to `undefined`, which would silently turn a test's explicit
	// `authenticationResults: undefined` (no trusted result at all) into the default DMARC_PASS.
	const authenticationResults = "authenticationResults" in options ? options.authenticationResults : DMARC_PASS;
	const { extra = {}, authenticationResults: _ignored, ...overrides } = options;
	const fields = { ...DEFAULT_MAIL, date: new Date().toUTCString(), ...overrides };
	const raw = mime(fields, extra);
	const rawR2Key = `inbound/${Date.now()}-${Math.random().toString(36).slice(2)}.eml`;
	await env.BUCKET.put(rawR2Key, raw);
	const headers = Object.fromEntries(
		Object.entries({ from: fields.from, to: fields.to, subject: fields.subject, ...extra }).map(([name, value]) => [
			name.toLowerCase(),
			String(value),
		]),
	);
	const payload = { from: "owner@example.com", to: "assistant@example.com", rawR2Key, headers, authenticationResults };
	await processInboundMessage(env, payload);
	return rawR2Key;
}

async function requests(database) {
	return database.db.prepare("SELECT * FROM assistant_email_requests ORDER BY created_at").all();
}

test("resolveInboundAddress matches an assistant address in phase 2, after reject rules and before any catch-all", async (t) => {
	const { db, database } = await setup(t);
	let decision = await resolveInboundAddress(db, "assistant@example.com", "owner@example.com");
	assert.deepEqual(decision, { action: "assistant", assistantAddressId: "asa-1" });

	database.db.exec(
		"INSERT INTO routing_rules (id, user_id, domain_id, scope, action, pattern, match_field, priority, enabled, created_at) VALUES ('rule-reject', 'owner', 'domain-1', 'domain', 'reject', 'owner@example.com', 'sender', 10, 1, 1)",
	);
	decision = await resolveInboundAddress(db, "assistant@example.com", "owner@example.com");
	assert.equal(decision.action, "reject");

	database.db.exec("DELETE FROM routing_rules");
	database.db.exec(
		"INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-catch', 'owner', 'domain-1', 'catch', 1)",
	);
	database.db.exec(
		"INSERT INTO routing_rules (id, user_id, domain_id, scope, action, pattern, match_field, mailbox_id, priority, enabled, created_at) VALUES ('rule-catch', 'owner', 'domain-1', 'domain', 'store', '*', 'recipient', 'mailbox-catch', 1, 1, 1)",
	);
	decision = await resolveInboundAddress(db, "assistant@example.com", "owner@example.com");
	assert.deepEqual(decision, { action: "assistant", assistantAddressId: "asa-1" });

	assert.equal(await isAssistantAddressTaken(db, "domain-1", "assistant"), true);
	assert.equal(await isAssistantAddressTaken(db, "domain-1", "someone-else"), false);
});

test("an authenticated request from the owner's own mailbox is accepted and queued", async (t) => {
	const { env, database, queued, bucket } = await setup(t);
	const rawR2Key = await deliver(env);
	const rows = await requests(database);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, "queued");
	assert.equal(rows[0].mailbox_id, "mailbox-a");
	assert.equal(rows[0].from_addr, "owner@example.com");
	assert.deepEqual(queued, [{ kind: "agent.assistant_email", requestId: rows[0].id }]);
	assert.ok(await bucket.get(rawR2Key), "the raw object is kept until the queue consumer runs");

	await processAssistantEmailRequest(env, rows[0].id);
	const after = await requests(database);
	assert.equal(after[0].status, "answered");
	assert.equal(after[0].raw_r2_key, null);
	assert.equal(await bucket.get(rawR2Key), null);
});

test("an aligned DKIM pass with no SPF result also authenticates the request", async (t) => {
	const { env, database } = await setup(t);
	await deliver(env, { authenticationResults: "mx.cloudflare.net; dkim=pass header.d=example.com" });
	assert.equal((await requests(database)).length, 1);
});

test("a DMARC failure, an unaligned DKIM pass, or no trusted result is dropped without a row", async (t) => {
	for (const authenticationResults of [
		DMARC_FAIL,
		"mx.cloudflare.net; dkim=pass header.d=esp.test; dmarc=none",
		null,
		undefined,
	]) {
		const { env, database, bucket, queued } = await setup(t);
		const rawR2Key = await deliver(env, { authenticationResults });
		assert.equal((await requests(database)).length, 0, JSON.stringify(authenticationResults));
		assert.equal(await bucket.get(rawR2Key), null);
		assert.deepEqual(queued, []);
	}
});

test("an unknown sender address is dropped without a row", async (t) => {
	const { env, database } = await setup(t);
	await deliver(env, { from: "stranger@example.com" });
	assert.equal((await requests(database)).length, 0);
});

test("a shared mailbox address does not count as an own address", async (t) => {
	const { env, database } = await setup(t);
	database.db.exec(
		"INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-shared', 'owner', 'domain-1', 'team', 'shared', 1)",
	);
	await deliver(env, { from: "Team <team@example.com>" });
	assert.equal((await requests(database)).length, 0);
});

test("loop and auto-reply headers, including X-Kite-Assistant, are dropped silently", async (t) => {
	for (const extra of [
		{ "Auto-Submitted": "auto-replied" },
		{ Precedence: "bulk" },
		{ "List-Id": "<news.example.com>" },
		{ "X-Auto-Response-Suppress": "All" },
		{ "X-Kite-Assistant": "1" },
	]) {
		const { env, database } = await setup(t);
		await deliver(env, { extra, messageId: `<${Math.random()}@example.com>` });
		assert.equal((await requests(database)).length, 0, Object.keys(extra)[0]);
	}
});

test("the same Message-ID twice produces exactly one row", async (t) => {
	const { env, database } = await setup(t);
	await deliver(env, { messageId: "<dup-1@example.com>" });
	await deliver(env, { messageId: "<dup-1@example.com>" });
	assert.equal((await requests(database)).length, 1);
});

test("a request more than 24 hours old or more than an hour in the future is dropped", async (t) => {
	const { env, database } = await setup(t);
	await deliver(env, {
		date: new Date(Date.now() - 25 * 60 * 60 * 1000).toUTCString(),
		messageId: "<old@example.com>",
	});
	await deliver(env, {
		date: new Date(Date.now() + 2 * 60 * 60 * 1000).toUTCString(),
		messageId: "<future@example.com>",
	});
	assert.equal((await requests(database)).length, 0);
});

test("a user who has not opted in, or whose assistant is off, never gets a row", async (t) => {
	const { env, database } = await setup(t);
	database.db.exec("UPDATE user_ai_settings SET assistant_email_enabled = 0 WHERE user_id = 'owner'");
	await deliver(env);
	assert.equal((await requests(database)).length, 0);
});

test("the user's own daily limit stops a request once it is reached", async (t) => {
	const { env, database } = await setup(t);
	database.db.exec("UPDATE user_ai_settings SET assistant_email_daily_limit = 1 WHERE user_id = 'owner'");
	await deliver(env, { messageId: "<first@example.com>" });
	await deliver(env, { messageId: "<second@example.com>" });
	assert.equal((await requests(database)).length, 1);
});

test("readUserAiSettings reports the opt-in and daily limit assistant intake reads", async (t) => {
	const { db } = await setup(t);
	const settings = await readUserAiSettings(db, "owner");
	assert.deepEqual(settings.assistantEmail, { enabled: true, mailboxId: null, dailyLimit: 20 });
});
