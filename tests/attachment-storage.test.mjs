import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXTURES } from "./fixtures/mime/fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle", "migrations");
const STORAGE_MIGRATION = "0088_attachment_raw_storage.sql";
const directory = makeBundleDirectory("kite-attachment-storage-test-");
const scratch = mkdtempSync(join(tmpdir(), "kite-attachment-storage-"));
after(() => {
	rmSync(directory, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { openAttachment, openRawAttachment, readAttachmentBytes } from "./src/lib/email/attachment-storage.ts";
			export { deleteUnreferencedObjects } from "./src/lib/email/attachment-storage.ts";
			export { deleteMessageWithObjects } from "./src/lib/email/message-cleanup.ts";
			export { permanentlyDeleteMessages } from "./src/lib/email/permanent-delete.ts";
			export { getDb } from "./src/db/index.ts";
			export {
				attachmentObjectKeys,
				isRawAttachmentKey,
				planObjectDeletion,
				rawAttachmentKey,
				resolveByteRange,
				sliceByteStream,
				toRawLocation,
				ATTACHMENT_OBJECT_ROWS_SQL,
			} from "./src/lib/email/attachment-storage-utils.ts";
			export {
				copyMessageAttachments,
				deleteMessageAttachment,
				listMessageAttachments,
				loadMessageAttachmentContents,
				storeMessageAttachments,
				storedAttachmentContent,
			} from "./src/lib/email/attachments.ts";
			export { indexMimeParts, matchAttachmentsToParts } from "./src/lib/email/mime-index-utils.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export { TableInsertBuilder } from "./src/lib/backups/restore-utils.ts";
			export { messageAttachments } from "./src/db/schema/index.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-storage-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const encoder = new TextEncoder();
let counter = 0;

/** The repository's migrations, optionally without this change's, so a database can be left one release behind. */
function migrationsUpTo(includeStorage) {
	if (includeStorage) return migrationsDir;
	const copy = join(scratch, `migrations-${++counter}`);
	mkdirSync(copy, { recursive: true });
	for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql") && file !== STORAGE_MIGRATION))
		copyFileSync(join(migrationsDir, name), join(copy, name));
	return copy;
}

async function setup({ migrated = true } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, migrationsUpTo(migrated));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			VALUES ('msg-in', 'owner', 'mailbox-a', 'inbound', 'sender@example.com', 'support@example.com', 'Fixture', 'received', 'inbound/1-msg.eml', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
			VALUES ('msg-draft', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'reader@example.com', 'Fwd: Fixture', 'draft', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
			VALUES ('msg-sent', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'reader@example.com', 'Fwd: Fixture', 'sent', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
			VALUES ('msg-other-draft', 'other', 'mailbox-a', 'outbound', 'support@example.com', 'reader@example.com', 'Fwd: Fixture', 'draft', 1);
	`);
	const bucket = new m.FileBucket(join(scratch, `bucket-${++counter}`));
	return { database, bucket, env: { DB: database, BUCKET: bucket } };
}

const columns = (database) =>
	database.db
		.prepare("PRAGMA table_info(message_attachments)")
		.all()
		.map((column) => column.name);
const indexes = (database) =>
	database.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_attachments'")
		.all()
		.map((row) => row.name)
		.sort();
const bytesOf = (value) => new Uint8Array(value);
const keyOf = (database, id) =>
	database.db.prepare("SELECT r2_key FROM message_attachments WHERE id = ?").get(id)?.r2_key;
const keysOf = (database, messageId) =>
	database.db
		.prepare("SELECT r2_key FROM message_attachments WHERE message_id = ? ORDER BY rowid")
		.all(messageId)
		.map((row) => row.r2_key);
const silenced = async (run) => {
	const error = console.error;
	console.error = () => {};
	try {
		return await run();
	} finally {
		console.error = error;
	}
};

test("utils: the raw sentinel, ranges and object keys", () => {
	assert.equal(m.rawAttachmentKey("att_1"), "raw:att_1");
	assert.ok(m.isRawAttachmentKey("raw:att_1"));
	assert.ok(!m.isRawAttachmentKey("attachments/msg/att_1/report.pdf"));
	assert.deepEqual(m.attachmentObjectKeys([{ r2Key: "raw:att_1" }, { r2Key: "attachments/a" }]), ["attachments/a"]);
	assert.equal(m.resolveByteRange(10, undefined), null);
	assert.deepEqual(m.resolveByteRange(10, { suffix: 4 }), { offset: 6, length: 4 });
	assert.deepEqual(m.resolveByteRange(10, { suffix: 40 }), { offset: 0, length: 10 });
	assert.deepEqual(m.resolveByteRange(10, { offset: 8 }), { offset: 8, length: 2 });
	assert.deepEqual(m.resolveByteRange(10, { offset: 8, length: 5 }), { offset: 8, length: 2 });
	assert.deepEqual(m.resolveByteRange(10, { offset: 12, length: 5 }), { offset: 10, length: 0 });
	assert.equal(m.toRawLocation({ rawKey: null, offset: 1, length: 1, encoding: "base64" }), null);
	assert.equal(m.toRawLocation({ rawKey: "inbound/a", offset: -1, length: 1, encoding: "base64" }), null);
	assert.equal(m.toRawLocation({ rawKey: "inbound/a", offset: 1, length: 1, encoding: "quoted-printable" }), null);
	assert.deepEqual(m.toRawLocation({ rawKey: "inbound/a", offset: 1, length: 2, encoding: "identity" }), {
		rawKey: "inbound/a",
		offset: 1,
		length: 2,
		encoding: "identity",
	});
	assert.match(m.ATTACHMENT_OBJECT_ROWS_SQL, /r2_key/);
});

test("utils: sliceByteStream keeps exactly the requested bytes across chunk edges", async () => {
	const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
	for (const [offset, length] of [
		[0, 100],
		[0, 1],
		[17, 33],
		[99, 1],
		[50, 0],
	]) {
		const source = new ReadableStream({
			start(controller) {
				for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.subarray(at, at + 7));
				controller.close();
			},
		});
		const sliced = bytesOf(await new Response(source.pipeThrough(m.sliceByteStream(offset, length))).arrayBuffer());
		assert.deepEqual(sliced, bytes.subarray(offset, offset + length));
	}
});

test("migration 0088 adds the storage columns, keeps rows 'object' and lets keys be shared", async () => {
	const { database } = await setup({ migrated: false });
	database.db.exec(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att-old', 'msg-in', 'a.pdf', 'application/pdf', 3, 'attachments/msg-in/att-old/a.pdf', 1)",
	);
	assert.ok(!columns(database).includes("storage"));
	assert.ok(indexes(database).includes("message_attachments_r2_key_unique"));
	await m.applyMigrations(database, migrationsDir);
	for (const column of ["storage", "raw_offset", "raw_length", "transfer_encoding", "sha256", "storage_checked_at"])
		assert.ok(columns(database).includes(column), column);
	assert.deepEqual(
		indexes(database).filter((name) => !name.startsWith("sqlite_")),
		["message_attachments_message_idx", "message_attachments_r2_key_idx", "message_attachments_sha256_idx"],
	);
	assert.equal(
		database.db.prepare("SELECT storage FROM message_attachments WHERE id = 'att-old'").get().storage,
		"object",
	);
	database.db.exec(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att-shared', 'msg-draft', 'a.pdf', 'application/pdf', 3, 'attachments/msg-in/att-old/a.pdf', 1)",
	);
});

for (const migrated of [false, true]) {
	test(`object attachments store, list, load, copy and delete ${migrated ? "after" : "before"} migration 0088`, async () => {
		const { env, bucket } = await setup({ migrated });
		const content = encoder.encode("%PDF-1.7 fixture").buffer;
		const [stored] = await m.storeMessageAttachments(env, "msg-in", [
			{ filename: "report.pdf", type: "application/pdf", content },
		]);
		assert.ok(!m.isRawAttachmentKey(stored.r2Key));
		assert.deepEqual(
			(await m.listMessageAttachments(env, "msg-in")).map((row) => row.filename),
			["report.pdf"],
		);
		const [loaded] = await m.loadMessageAttachmentContents(env, "msg-in");
		assert.deepEqual(bytesOf(loaded.content), bytesOf(content));
		const opened = await m.openAttachment(env, { ...stored, contentType: stored.type }, { range: { suffix: 7 } });
		assert.equal(opened.size, 7);
		assert.equal(await new Response(opened.body).text(), "fixture");
		const [copy] = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
		const copyKey = keyOf(env.DB, copy.id);
		// After 0088 a forward names the original's object; before it keys are unique, so the bytes are copied.
		if (migrated) assert.equal(copyKey, stored.r2Key);
		else assert.notEqual(copyKey, stored.r2Key);
		assert.equal(copy.size, content.byteLength);
		assert.ok(await m.deleteMessageAttachment(env, "msg-draft", copy.id));
		assert.ok(await bucket.get(stored.r2Key), "the original object stays");
		if (!migrated) assert.equal(await bucket.get(copyKey), null, "the copy's own object went with it");
		const [again] = await m.loadMessageAttachmentContents(env, "msg-in");
		assert.deepEqual(bytesOf(again.content), bytesOf(content));
	});
}

/** Stores a fixture's raw message and writes 'raw' rows for the attachments the index verified, as ingest will. */
async function rawFixture(env, database, fixtureName) {
	const raw = encoder.encode(FIXTURES.find((fixture) => fixture.name === fixtureName).raw);
	await env.BUCKET.put("inbound/1-msg.eml", raw);
	const parsed = await m.parseRawMime(raw.buffer);
	const { matches } = m.matchAttachmentsToParts(raw, parsed.attachments, m.indexMimeParts(raw));
	const insert = database.db.prepare(
		`INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, content_id, r2_key,
			storage, raw_offset, raw_length, transfer_encoding, created_at)
		VALUES (?, 'msg-in', ?, ?, ?, ?, ?, ?, 'raw', ?, ?, ?, 1)`,
	);
	return matches.map(({ attachmentIndex, part }, index) => {
		const attachment = parsed.attachments[attachmentIndex];
		const id = `att-raw-${index}`;
		insert.run(
			id,
			attachment.filename,
			attachment.type,
			attachment.content.byteLength,
			attachment.disposition,
			attachment.contentId,
			m.rawAttachmentKey(id),
			part.bodyOffset,
			part.bodyLength,
			part.transferEncoding,
		);
		return {
			id,
			r2Key: m.rawAttachmentKey(id),
			size: attachment.content.byteLength,
			contentType: attachment.type,
			content: bytesOf(attachment.content),
		};
	});
}

test("a 'raw' row is served by decoding its exact range of the raw message", async () => {
	const { env, database } = await setup();
	const rows = await rawFixture(env, database, "related inside alternative inside mixed, with an inline cid image");
	assert.equal(rows.length, 2);
	for (const row of rows) {
		const opened = await m.openAttachment(env, row);
		assert.equal(opened.size, row.size);
		assert.deepEqual(bytesOf(await new Response(opened.body).arrayBuffer()), row.content);
		const tail = await m.readAttachmentBytes(env, row, { range: { suffix: 100 } });
		assert.deepEqual(bytesOf(tail), row.content.subarray(row.content.length - 100));
		const middle = await m.readAttachmentBytes(env, row, { range: { offset: 10, length: 50 } });
		assert.deepEqual(bytesOf(middle), row.content.subarray(10, 60));
		// The sentinel names no object, so a reader that skipped the accessor gets nothing.
		assert.equal(await env.BUCKET.get(row.r2Key), null);
	}
	const loaded = await m.loadMessageAttachmentContents(env, "msg-in");
	assert.deepEqual(
		loaded.map((attachment) => bytesOf(attachment.content)),
		rows.map((row) => row.content),
	);
	// Forwarding a raw row writes a decoded object of its own, so the draft never depends on the raw.
	const copies = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
	const drafted = database.db
		.prepare("SELECT r2_key, storage FROM message_attachments WHERE message_id = 'msg-draft'")
		.all();
	assert.equal(copies.length, 2);
	assert.ok(drafted.every((row) => row.storage === "object" && !m.isRawAttachmentKey(row.r2_key)));
	for (const [index, copy] of copies.entries()) await m.deleteMessageAttachment(env, "msg-draft", copy.id);
	assert.ok(await env.BUCKET.get("inbound/1-msg.eml"), "deleting the copies leaves the raw message");
});

test("identity rows read their range directly, and broken rows read as missing", async () => {
	const { env, bucket } = await setup();
	await bucket.put("inbound/1-msg.eml", "Header: x\r\n\r\nplain bytes here\r\n");
	const location = { rawKey: "inbound/1-msg.eml", offset: 13, length: 16, encoding: "identity" };
	const row = { size: 16, contentType: "text/plain" };
	const whole = await m.openRawAttachment(bucket, location, row);
	assert.equal(await new Response(whole.body).text(), "plain bytes here");
	const part = await m.openRawAttachment(bucket, location, row, { offset: 6, length: 5 });
	assert.equal(part.size, 5);
	assert.equal(await new Response(part.body).text(), "bytes");
	const none = await m.openRawAttachment(bucket, location, row, { offset: 16 });
	assert.equal(none.size, 0);
	assert.equal(await m.openRawAttachment(bucket, { ...location, rawKey: "inbound/missing.eml" }, row), null);
	// A sentinel key without a 'raw' row (a restored or half-written row) never falls back to anything else.
	assert.equal(
		await m.openAttachment(env, { id: "att-none", r2Key: "raw:att-none", size: 1, contentType: "text/plain" }),
		null,
	);
});

/** Runs a restore insert for one backed-up attachment row the way the restore planner builds it. */
function restoreRow(database, row) {
	const target = new Set(columns(database));
	const builder = new m.TableInsertBuilder("message_attachments", target);
	builder.add(row);
	const { statement } = builder.finish();
	database.db.prepare(statement.sql).run(...statement.params);
}

test("backups restore both ways across migration 0088", async () => {
	const older = {
		id: "att-a",
		message_id: "msg-in",
		filename: "a.pdf",
		content_type: "application/pdf",
		size: 3,
		disposition: "attachment",
		content_id: null,
		r2_key: "attachments/msg-in/att-a/a.pdf",
		created_at: 1,
	};
	const { database: migrated } = await setup();
	restoreRow(migrated, older);
	assert.equal(
		migrated.db.prepare("SELECT storage FROM message_attachments WHERE id = 'att-a'").get().storage,
		"object",
	);
	const newer = {
		...older,
		id: "att-b",
		storage: "object",
		raw_offset: null,
		raw_length: null,
		transfer_encoding: null,
		sha256: null,
		storage_checked_at: null,
	};
	const { database: behind } = await setup({ migrated: false });
	restoreRow(behind, newer);
	assert.equal(behind.db.prepare("SELECT count(*) AS n FROM message_attachments WHERE id = 'att-b'").get().n, 1);
});

test("the sha256 index is partial, in the migration and in the Drizzle schema", async () => {
	const { database } = await setup();
	const { sql } = database.db
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'message_attachments_sha256_idx'")
		.get();
	assert.match(sql, /\(`sha256`, `size`\) WHERE `sha256` IS NOT NULL$/);
	const plan = database.db
		.prepare("EXPLAIN QUERY PLAN SELECT id FROM message_attachments WHERE sha256 = ? AND size = ?")
		.all("ab", 3)
		.map((row) => row.detail)
		.join(" ");
	assert.match(plan, /message_attachments_sha256_idx/);
	const index = getTableConfig(m.messageAttachments).indexes.find(
		(entry) => entry.config.name === "message_attachments_sha256_idx",
	);
	assert.ok(index?.config.where, "the Drizzle index carries the same WHERE");
});

test("a raw: row restored into a database without 0088 reads as not stored instead of failing", async () => {
	const { env, database } = await setup({ migrated: false });
	database.db.exec(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att-new', 'msg-in', 'a.pdf', 'application/pdf', 3, 'raw:att-new', 1)",
	);
	const row = { id: "att-new", r2Key: "raw:att-new", size: 3, contentType: "application/pdf" };
	assert.equal(await m.openAttachment(env, row), null);
	assert.equal(await m.readAttachmentBytes(env, row), null);
	assert.deepEqual(await m.loadMessageAttachmentContents(env, "msg-in"), []);
});

test("utils: sliceByteStream cancels its source once the range is complete", async () => {
	let pulled = 0;
	let cancelled = false;
	const source = new ReadableStream({
		pull(controller) {
			pulled++;
			controller.enqueue(new Uint8Array(10).fill(pulled));
		},
		cancel() {
			cancelled = true;
		},
	});
	const sliced = new Uint8Array(await new Response(source.pipeThrough(m.sliceByteStream(5, 10))).arrayBuffer());
	assert.deepEqual([...sliced], [1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
	assert.ok(cancelled, "the endless source was cancelled");
	assert.ok(pulled <= 4, `pulled ${pulled} chunks`);
});

test("utils: the delete planner keeps shared keys and never names a sentinel", () => {
	const planned = m.planObjectDeletion(
		{
			attachmentKeys: ["attachments/a", "attachments/shared", "raw:att_1", "attachments/a"],
			rawKeys: ["inbound/1.eml", null, "inbound/shared.eml", "inbound/1.eml"],
			ownedKeys: ["bodies/msg.html", "raw:att_2"],
		},
		{ attachmentKeys: ["attachments/shared"], rawKeys: ["inbound/shared.eml"] },
	);
	assert.deepEqual(planned, ["attachments/a", "inbound/1.eml", "bodies/msg.html"]);
	assert.deepEqual(m.planObjectDeletion({}, { attachmentKeys: [], rawKeys: [] }), []);
	// A key named only as a raw message is checked against messages, never dropped for an attachment reference.
	assert.deepEqual(
		m.planObjectDeletion({ rawKeys: ["inbound/2.eml"] }, { attachmentKeys: ["attachments/b"], rawKeys: [] }),
		["inbound/2.eml"],
	);
	assert.deepEqual(m.attachmentObjectKeys([{ r2Key: "attachments/a" }, { r2Key: "attachments/a" }]), ["attachments/a"]);
});

test("a send from a draft shares the draft's objects, and deleting the draft keeps them", async () => {
	const { env, bucket, database } = await setup();
	const content = encoder.encode("%PDF-1.7 the draft's file").buffer;
	const [uploaded] = await m.storeMessageAttachments(env, "msg-draft", [
		{ filename: "plan.pdf", type: "application/pdf", content },
	]);
	const loaded = await m.loadMessageAttachmentContents(env, "msg-draft");
	const [sent] = await m.storeMessageAttachments(env, "msg-sent", loaded);
	assert.equal(sent.r2Key, uploaded.r2Key, "the sent row names the draft's object");
	assert.equal(sent.size, content.byteLength);

	await m.deleteMessageWithObjects(env, m.getDb(env), "msg-draft", null);
	assert.deepEqual(keysOf(database, "msg-draft"), []);
	const [again] = await m.loadMessageAttachmentContents(env, "msg-sent");
	assert.deepEqual(bytesOf(again.content), bytesOf(content), "the sent copy still reads byte-exact");

	await m.deleteMessageWithObjects(env, m.getDb(env), "msg-sent", null);
	assert.equal(await bucket.get(uploaded.r2Key), null, "the last reference took the object with it");
});

test("a storageId from a request body never shares another row's object", async () => {
	const { env, database } = await setup();
	const [original] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "secret.pdf", type: "application/pdf", content: encoder.encode("private").buffer },
	]);
	// What a JSON body could carry: the id of a row the sender may not read, with bytes of its own.
	const forged = {
		storageId: original.id,
		filename: "x.pdf",
		type: "application/pdf",
		content: encoder.encode("x").buffer,
	};
	const [stored] = await m.storeMessageAttachments(env, "msg-sent", [forged]);
	assert.notEqual(stored.r2Key, original.r2Key);
	const [read] = await m.loadMessageAttachmentContents(env, "msg-sent");
	assert.equal(new TextDecoder().decode(read.content), "x");
	assert.equal(keysOf(database, "msg-sent").length, 1);
});

test("a share whose source is gone writes the bytes it has instead", async () => {
	const { env, bucket, database } = await setup();
	const [uploaded] = await m.storeMessageAttachments(env, "msg-draft", [
		{ filename: "a.txt", type: "text/plain", content: encoder.encode("kept bytes").buffer },
	]);
	const loaded = await m.loadMessageAttachmentContents(env, "msg-draft");
	// The draft is deleted between reading its files and storing the send.
	await m.deleteMessageWithObjects(env, m.getDb(env), "msg-draft", null);
	assert.equal(await bucket.get(uploaded.r2Key), null);
	const [sent] = await m.storeMessageAttachments(env, "msg-sent", loaded);
	assert.notEqual(sent.r2Key, uploaded.r2Key);
	assert.equal(await (await bucket.get(sent.r2Key)).text(), "kept bytes");
	assert.deepEqual(keysOf(database, "msg-sent"), [sent.r2Key]);
});

test("the assistant's attached file shares its source row's object", async () => {
	const { env } = await setup();
	const [original] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "a.pdf", type: "application/pdf", content: encoder.encode("bytes").buffer, contentId: "cid-1" },
	]);
	const row = { ...original, contentType: original.type, contentId: null };
	const [stored] = await m.storeMessageAttachments(env, "msg-draft", [
		m.storedAttachmentContent(row, encoder.encode("bytes").buffer),
	]);
	assert.equal(stored.r2Key, original.r2Key);
	assert.equal(stored.contentId, null);
	// A 'raw' row's sentinel is never shared, even from server code.
	const raw = m.storedAttachmentContent({ ...row, id: "att-raw", r2Key: "raw:att-raw" }, encoder.encode("r").buffer);
	const [own] = await m.storeMessageAttachments(env, "msg-draft", [raw]);
	assert.ok(!m.isRawAttachmentKey(own.r2Key));
});

test("a failed store removes its rows and its own objects, never a shared one", async () => {
	const { env, bucket, database } = await setup();
	const [original] = await m.storeMessageAttachments(env, "msg-draft", [
		{ filename: "a.txt", type: "text/plain", content: encoder.encode("shared").buffer },
	]);
	const loaded = await m.loadMessageAttachmentContents(env, "msg-draft");
	const put = bucket.put.bind(bucket);
	let puts = 0;
	bucket.put = async (...args) => {
		if (++puts === 2) throw new Error("storage down");
		return put(...args);
	};
	const fresh = (name) => ({ filename: name, type: "text/plain", content: encoder.encode(name).buffer });
	await assert.rejects(
		silenced(() => m.storeMessageAttachments(env, "msg-sent", [...loaded, fresh("one.txt"), fresh("two.txt")])),
		/storage down/,
	);
	bucket.put = put;
	assert.deepEqual(keysOf(database, "msg-sent"), []);
	assert.equal(await (await bucket.get(original.r2Key)).text(), "shared", "the shared object stays");
	assert.deepEqual(keysOf(database, "msg-draft"), [original.r2Key]);
});

test("forwarding a 'raw' row twice stores its bytes once per user", async () => {
	const { env, database } = await setup();
	const rows = await rawFixture(env, database, "related inside alternative inside mixed, with an inline cid image");
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
			VALUES ('msg-draft-2', 'owner', 'mailbox-a', 'outbound', 'support@example.com', 'reader@example.com', 'Fwd', 'draft', 1);
	`);
	const first = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
	const second = await m.copyMessageAttachments(env, "msg-in", "msg-draft-2");
	const other = await m.copyMessageAttachments(env, "msg-in", "msg-other-draft");
	assert.equal(first.length, rows.length);
	assert.deepEqual(
		keysOf(database, "msg-draft-2"),
		keysOf(database, "msg-draft"),
		"the same user's second forward shares",
	);
	for (const key of keysOf(database, "msg-other-draft"))
		assert.ok(!keysOf(database, "msg-draft").includes(key), "another user's forward gets objects of its own");
	assert.equal(second.length, rows.length);
	assert.equal(other.length, rows.length);
	const digests = database.db
		.prepare("SELECT DISTINCT sha256 FROM message_attachments WHERE message_id = 'msg-draft-2'")
		.all();
	assert.equal(digests.length, rows.length);
	for (const [index, copy] of second.entries()) {
		const [stored] = (await m.loadMessageAttachmentContents(env, "msg-draft-2")).filter(
			(item) => item.storageId === copy.id,
		);
		assert.deepEqual(bytesOf(stored.content), rows[index].content);
	}
	// A 'raw' row is part of its message and cannot be removed on its own.
	assert.equal(await m.deleteMessageAttachment(env, "msg-in", rows[0].id), false);
	assert.equal(
		database.db.prepare("SELECT count(*) AS n FROM message_attachments WHERE message_id = 'msg-in'").get().n,
		2,
	);
});

test("permanent delete removes rows first and keeps objects other messages name", async () => {
	const { env, bucket, database } = await setup();
	database.db.exec(
		"UPDATE messages SET status = 'trash'; UPDATE messages SET raw_r2_key = 'inbound/1-msg.eml' WHERE id = 'msg-sent'",
	);
	await bucket.put("inbound/1-msg.eml", "raw");
	const [original] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "a.txt", type: "text/plain", content: encoder.encode("original").buffer },
	]);
	const [forwarded] = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
	assert.equal(keyOf(database, forwarded.id), original.r2Key);
	const deletable = (id) => ({ id, mailboxId: "mailbox-a", rawR2Key: "inbound/1-msg.eml", status: "trash" });

	await m.permanentlyDeleteMessages(env, m.getDb(env), "owner", [deletable("msg-in")], "bulk");
	assert.equal(await (await bucket.get(original.r2Key)).text(), "original", "the forward still names the object");
	assert.ok(await bucket.get("inbound/1-msg.eml"), "another message still names the raw");

	await m.permanentlyDeleteMessages(
		env,
		m.getDb(env),
		"owner",
		[deletable("msg-draft"), deletable("msg-sent")],
		"empty",
	);
	assert.equal(await bucket.get(original.r2Key), null);
	assert.equal(await bucket.get("inbound/1-msg.eml"), null);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM message_attachments").get().n, 0);
});

test("deleting unreferenced objects never throws once the rows are gone", async () => {
	const { env, bucket } = await setup();
	await bucket.put("attachments/x/y", "orphan");
	bucket.delete = async () => {
		throw new Error("storage down");
	};
	await silenced(() => m.deleteUnreferencedObjects(env, { attachmentKeys: ["attachments/x/y"] }));
	env.DB = {
		prepare() {
			throw new Error("database down");
		},
	};
	await silenced(() => m.deleteUnreferencedObjects(env, { attachmentKeys: ["attachments/x/y"], ownedKeys: ["b"] }));
});
