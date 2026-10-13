import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { bundleModules, root } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	moduleHost,
	setUserModuleAllowed,
	setModuleEnabled,
	encodeRawMime,
	decodeHostImportMessage,
} = await bundleModules("kite-module-host-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["moduleHost", "src/lib/modules/host.ts"],
	["setUserModuleAllowed, setModuleEnabled", "src/lib/modules/state.ts"],
	["encodeRawMime, decodeHostImportMessage", "src/lib/email/module-import-utils.ts"],
]);

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

const ctx = (userId = "owner", extra = {}) => ({
	viewer: userId ? { userId, role: "user", isPrimaryAdmin: false } : null,
	requestId: "req-1",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	trigger: "api",
	...extra,
});

const message = (id, subject) =>
	`From: Alice <alice@partner.test>\r\nTo: support@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${id}@partner.test>\r\nDate: Tue, 01 Oct 2024 10:00:00 +0000\r\n\r\nHello from ${id}\r\n`;

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, time_zone, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'Europe/Paris', 'admin', 1, 1),
			('member', 'member@example.com', 'hash', 'Member', NULL, 'user', 0, 1),
			('stranger', 'stranger@example.com', 'hash', 'Stranger', NULL, 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('source-1', 'owner', 'mailbox-a', 'inbound', '<source-1@partner.test>', 'alice@partner.test', 'support@example.com', 'Planning', 'Join us', 'received', 1700000000);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES
			('att-ics', 'source-1', 'invite.ics', 'text/calendar', 22, 'attachment', 'att/ics', 1),
			('att-bin', 'source-1', 'photo.bin', 'application/octet-stream', 4, 'attachment', 'att/bin', 1);
	`);
	const objects = new Map([
		["att/ics", new TextEncoder().encode("BEGIN:VCALENDAR\r\nEND:VC")],
		["att/bin", new Uint8Array([0, 255, 128, 7])],
	]);
	const put = [];
	const env = {
		DB: db,
		BUCKET: {
			put: async (key, value) => {
				put.push(key);
				objects.set(key, new Uint8Array(value));
			},
			get: async (key, options) => {
				const bytes = objects.get(key);
				if (!bytes) return null;
				const cut = options?.range
					? bytes.slice(options.range.offset ?? 0, (options.range.offset ?? 0) + options.range.length)
					: bytes;
				return { arrayBuffer: async () => cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength) };
			},
			delete: async () => undefined,
		},
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, put };
}

test("no ModuleHost method is a stub", () => {
	const source = readFileSync(join(root, "src/lib/modules/host.ts"), "utf8");
	assert.doesNotMatch(source, /not implemented yet|pending\(/);
	const paths = [
		"emitWebhook",
		"invoke",
		"modules.isEnabledFor",
		"resolveRefs",
		"mail.getMessage",
		"mail.readAttachment",
		"mail.send",
		"mail.importMessages",
		"users.getProfile",
		"audit",
	];
	for (const path of paths) {
		const value = path.split(".").reduce((target, key) => target[key], moduleHost);
		assert.equal(typeof value, "function", path);
	}
});

test("importMessages writes text, base64 and byte-array messages through the import path and reports duplicates apart", async (t) => {
	const { db, put } = await setup(t);
	const request = (messages, destination = "system:inbox") => ({
		userId: "owner",
		mailboxId: "mailbox-a",
		destination,
		messages,
	});
	const bytes = [...new TextEncoder().encode(message("c", "Bytes"))];
	const first = await moduleHost.mail.importMessages(
		ctx(null, { trigger: "queue" }),
		request([
			{ raw: message("a", "Plain"), filename: "a.eml" },
			{ raw: encodeRawMime(new TextEncoder().encode(message("b", "Encoded")).buffer), encoding: "base64" },
			{ raw: bytes },
		]),
	);
	assert.deepEqual(first, { imported: 3, skipped: 0, failed: 0, errors: [] });
	const rows = db.db
		.prepare("SELECT subject, status, folder_id, raw_r2_key FROM messages WHERE id <> 'source-1' ORDER BY subject")
		.all();
	assert.deepEqual(
		rows.map((row) => [row.subject, row.status]),
		[
			["Bytes", "received"],
			["Encoded", "received"],
			["Plain", "received"],
		],
	);
	assert.equal(put.length, 3, "each message's raw MIME is stored");

	const again = await moduleHost.mail.importMessages(ctx(null), request([{ raw: message("a", "Plain") }]));
	assert.deepEqual(again, { imported: 0, skipped: 1, failed: 0, errors: [] });

	await assert.rejects(
		() => moduleHost.mail.importMessages(ctx(null), request([{ raw: message("d", "x") }], "nowhere")),
		/destination/i,
	);
	assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 4);
});

test("a message that cannot be stored counts as failed with its reason", async (t) => {
	const { env } = await setup(t);
	env.BUCKET.put = async () => {
		throw new Error("bucket unavailable");
	};
	const result = await moduleHost.mail.importMessages(ctx(null), {
		userId: "owner",
		mailboxId: "mailbox-a",
		destination: "system:inbox",
		messages: [{ raw: message("e", "Broken"), filename: "e.eml" }],
	});
	assert.equal(result.imported, 0);
	assert.equal(result.failed, 1);
	assert.equal(result.skipped, 0);
	assert.match(result.errors[0], /^e\.eml: /);
});

test("raw MIME survives the base64 and byte-array encodings byte for byte", () => {
	const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 13]);
	const encoded = encodeRawMime(original);
	const viaBase64 = decodeHostImportMessage({ raw: encoded, encoding: "base64" }, 0);
	assert.deepEqual([...new Uint8Array(viaBase64.raw)], [...original]);
	assert.equal(viaBase64.filename, "message-1.eml");
	const viaArray = decodeHostImportMessage({ raw: [...original], filename: " saved.eml " }, 4);
	assert.deepEqual([...new Uint8Array(viaArray.raw)], [...original]);
	assert.equal(viaArray.filename, "saved.eml");
	const big = new Uint8Array(100_000).map((_, index) => index % 256);
	assert.deepEqual(
		[...new Uint8Array(decodeHostImportMessage({ raw: encodeRawMime(big), encoding: "base64" }, 0).raw)],
		[...big],
	);
	assert.equal(new TextDecoder().decode(decodeHostImportMessage({ raw: "héllo" }, 0).raw), "héllo");
});

test("getMessage returns a minimal view for a reader of the mailbox and null for anyone else", async (t) => {
	await setup(t);
	const view = await moduleHost.mail.getMessage(ctx("owner"), "source-1");
	assert.equal(view.id, "source-1");
	assert.equal(view.mailboxId, "mailbox-a");
	assert.equal(view.from, "alice@partner.test");
	assert.equal(view.subject, "Planning");
	assert.equal(view.receivedAt, new Date(1700000000 * 1000).toISOString());
	assert.deepEqual(
		view.attachments.map((item) => [item.id, item.contentType, item.filename, item.size]),
		[
			["att-ics", "text/calendar", "invite.ics", 22],
			["att-bin", "application/octet-stream", "photo.bin", 4],
		],
	);
	assert.equal(await moduleHost.mail.getMessage(ctx("stranger"), "source-1"), null);
	assert.equal(await moduleHost.mail.getMessage(ctx("owner"), "missing"), null);
	await assert.rejects(() => moduleHost.mail.getMessage(ctx(null), "source-1"), /acting user/);
});

test("readAttachment returns text for calendar parts, base64 for binary parts and cuts at maxBytes", async (t) => {
	await setup(t);
	const text = await moduleHost.mail.readAttachment(ctx("owner"), "source-1", "att-ics", { maxBytes: 100 });
	assert.deepEqual(text, { encoding: "text", content: "BEGIN:VCALENDAR\r\nEND:VC", truncated: false });
	const cut = await moduleHost.mail.readAttachment(ctx("owner"), "source-1", "att-ics", { maxBytes: 5 });
	assert.deepEqual(cut, { encoding: "text", content: "BEGIN", truncated: true });
	const binary = await moduleHost.mail.readAttachment(ctx("owner"), "source-1", "att-bin", { maxBytes: 100 });
	assert.deepEqual(binary, {
		encoding: "base64",
		content: Buffer.from([0, 255, 128, 7]).toString("base64"),
		truncated: false,
	});
	assert.equal(await moduleHost.mail.readAttachment(ctx("stranger"), "source-1", "att-ics", { maxBytes: 100 }), null);
	assert.equal(await moduleHost.mail.readAttachment(ctx("owner"), "source-1", "nope", { maxBytes: 100 }), null);
});

test("users.getProfile returns the display name, address and time zone", async (t) => {
	await setup(t);
	assert.deepEqual(await moduleHost.users.getProfile(ctx(), "owner"), {
		id: "owner",
		name: "Owner",
		email: "owner@example.com",
		timeZone: "Europe/Paris",
	});
	assert.equal((await moduleHost.users.getProfile(ctx(), "member")).timeZone, null);
	assert.equal(await moduleHost.users.getProfile(ctx(), "missing"), null);
});

test("audit writes a row for the acting user and wraps a value that is not an object", async (t) => {
	const { db } = await setup(t);
	await moduleHost.audit(ctx("member"), "booking.example", { ref: { kind: "user:user", id: "member" } });
	await moduleHost.audit(ctx(null, { trigger: "cron" }), "import.example", "done");
	const rows = db.db.prepare("SELECT actor_user_id, action, metadata FROM audit_logs ORDER BY action").all();
	assert.deepEqual(
		rows.map((row) => [row.actor_user_id, row.action, JSON.parse(row.metadata)]),
		[
			["member", "booking.example", { ref: { kind: "user:user", id: "member" } }],
			[null, "import.example", { value: "done" }],
		],
	);
});

test("modules.isEnabledFor follows the install switch and the user's own access, and the owner is always allowed", async (t) => {
	const { env } = await setup(t);
	const ask = (userId) => moduleHost.modules.isEnabledFor(ctx(null, { trigger: "queue" }), userId, "import");
	assert.equal(await ask("member"), true);
	await setUserModuleAllowed(env, { userId: "member", moduleId: "import", allowed: false, updatedBy: "owner" });
	assert.equal(await ask("member"), false);
	assert.equal(await ask("stranger"), true);
	await setUserModuleAllowed(env, { userId: "owner", moduleId: "import", allowed: false, updatedBy: "owner" });
	assert.equal(await ask("owner"), true, "the primary admin ignores a stored restriction");
	await setModuleEnabled(env, { moduleId: "import", enabled: false, updatedBy: "owner" });
	assert.equal(await ask("stranger"), false);
	assert.equal(await ask("missing"), false);
});
