import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

/**
 * Outbound contacts mean "someone the user chose to write to": the send review treats them as familiar and
 * automatic reading as known. Only delivered mail the user sent records them (upstream Mailflare #225).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-send-contacts-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { cancelQueuedSend, processOutboundQueue, sendEmail } from "./src/lib/email/send.ts";
			export { unfamiliarRecipients } from "./src/lib/agent/approvals/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "send-contacts-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

async function fixture(t, send = async () => ({ messageId: "<id@one.test>" })) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone', 'active', 'cloudflare', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'admin', 'one', 'owner', 1);
	`);
	const queued = [];
	const env = {
		DB: database,
		BUCKET: { get: async () => null, put: async () => undefined, delete: async () => undefined },
		EMAIL: { send },
		OUTBOUND_QUEUE: { send: async (body) => queued.push(body) },
		KITE_RUNTIME: "node",
	};
	const contacts = () =>
		database.db
			.prepare("SELECT email, source FROM contacts WHERE user_id = 'admin' ORDER BY email")
			.all()
			.map((row) => `${row.email}:${row.source}`);
	return { env, contacts, queued };
}

const mail = (overrides = {}) => ({
	userId: "admin",
	from: "owner@one.test",
	mailboxId: "mb",
	to: "Friend <friend@x.test>",
	cc: "colleague@x.test",
	subject: "Hello",
	text: "Hi",
	...overrides,
});

test("a delivered send makes its recipients familiar outbound contacts", async (t) => {
	const { env, contacts } = await fixture(t);
	await m.sendEmail(env, mail());
	assert.deepEqual(contacts(), ["colleague@x.test:outbound", "friend@x.test:outbound"]);
	assert.deepEqual(await m.unfamiliarRecipients(env, "admin", { to: "friend@x.test", cc: null, bcc: null }), []);
});

test("a send the provider refused records no contact", async (t) => {
	const { env, contacts } = await fixture(t, async () => {
		throw new Error("provider down");
	});
	await assert.rejects(m.sendEmail(env, mail()));
	assert.deepEqual(contacts(), []);
});

test("auto-replies and module mail such as RSVPs never make a stranger familiar", async (t) => {
	const { env, contacts } = await fixture(t);
	await m.sendEmail(env, mail({ to: "stranger@x.test", cc: undefined, headers: { "auto-submitted": "auto-replied" } }));
	await m.sendEmail(env, mail({ to: "organizer@x.test", cc: undefined, recordContacts: false }));
	assert.deepEqual(contacts(), []);
	assert.deepEqual(
		await m.unfamiliarRecipients(env, "admin", { to: "stranger@x.test, organizer@x.test", cc: null, bcc: null }),
		["stranger@x.test", "organizer@x.test"],
	);
});

test("a scheduled send records contacts only once delivered, and a cancelled one never does", async (t) => {
	const { env, contacts, queued } = await fixture(t);
	const later = new Date(Date.now() + 60 * 60_000).toISOString();
	const cancelled = await m.sendEmail(env, mail({ to: "cancelled@x.test", cc: undefined, scheduledAt: later }));
	assert.equal(cancelled.scheduled, true);
	assert.deepEqual(contacts(), []);
	assert.deepEqual(await m.cancelQueuedSend(env, "admin", cancelled.messageId), {
		ok: true,
		draftId: cancelled.messageId,
	});
	assert.deepEqual(contacts(), []);

	const due = await m.sendEmail(env, mail({ to: "due@x.test", cc: undefined, scheduledAt: later }));
	assert.deepEqual(contacts(), []);
	const message = queued.find((body) => body.messageId === due.messageId);
	await m.processOutboundQueue(env, { ...message, scheduledAt: new Date(Date.now() - 1_000).toISOString() });
	assert.deepEqual(contacts(), ["due@x.test:outbound"]);
});
