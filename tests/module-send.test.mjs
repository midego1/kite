import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-module-send-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		host: fileURLToPath(import.meta.resolve("../src/lib/modules/host.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { moduleHost } = await load("host");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

async function setup(t, limits = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1), ('other', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('source-1', 'owner', 'mailbox-a', 'inbound', '<source-1@partner.test>', 'Alice <alice@partner.test>', 'support@example.com', 'Planning', 'Join us', 'received', 1);
	`);
	const sent = [];
	const env = {
		DB: db,
		BUCKET: { put: async () => undefined, get: async () => null, delete: async () => undefined },
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: `<sent-${sent.length}@cf.test>` };
			},
		},
		OUTBOUND_QUEUE: { send: async () => undefined },
		...limits,
	};
	globalThis.__kiteNodeEnv = env;
	return { db, sent };
}

const ctx = (userId = "owner") => ({
	viewer: userId ? { userId, role: "user", isPrimaryAdmin: false } : null,
	requestId: "req-1",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "api",
});

const draft = (extra = {}) => ({
	mailboxId: "mailbox-a",
	to: ["alice@partner.test"],
	subject: "Hello",
	text: "Hi",
	...extra,
});

test("a module send goes through the normal send path and records the acting user's job", async (t) => {
	const { db, sent } = await setup(t);
	const result = await moduleHost.mail.send(ctx(), draft({ messageId: "msg_fixed" }));
	assert.equal(result.messageId, "msg_fixed");
	assert.equal(sent.length, 1);
	const jobs = db.db.prepare("SELECT user_id FROM outbound_jobs").all();
	assert.deepEqual(
		jobs.map((job) => job.user_id),
		["owner"],
	);
});

test("a module send counts against the acting user's send limit and is refused when it is reached", async (t) => {
	const { db, sent } = await setup(t, { SEND_LIMIT_PER_HOUR: "2", SEND_LIMIT_PER_DAY: "0" });
	await moduleHost.mail.send(ctx(), draft());
	await moduleHost.mail.send(ctx(), draft());
	await assert.rejects(() => moduleHost.mail.send(ctx(), draft()), /Sending limit reached: at most 2 messages an hour/);
	assert.equal(sent.length, 2);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM outbound_jobs").get().n, 2);
});

test("a send without a viewer is refused", async (t) => {
	await setup(t);
	await assert.rejects(() => moduleHost.mail.send(ctx(null), draft()), /acting user/);
});

test("a calendar part becomes an invite.ics attachment and a reply threads under the stored message", async (t) => {
	const { sent } = await setup(t);
	await moduleHost.mail.send(
		ctx(),
		draft({
			inReplyToMessageId: "source-1",
			calendar: { method: "REPLY", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
		}),
	);
	const [message] = sent;
	const [attachment] = message.attachments;
	assert.equal(attachment.filename, "invite.ics");
	assert.match(attachment.type, /^text\/calendar; method=REPLY/);
	assert.match(JSON.stringify(message), /source-1@partner\.test/);
});
