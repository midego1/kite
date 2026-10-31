import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
			export {
				getAttachmentStorageCounts,
				verifyAttachmentObjects,
			} from "./src/lib/email/attachment-storage-report.ts";
			export { deleteMessageWithObjects } from "./src/lib/email/message-cleanup.ts";
			export { permanentlyDeleteMessages } from "./src/lib/email/permanent-delete.ts";
			export { getDb } from "./src/db/index.ts";
			export {
				attachmentObjectKeys,
				findAttachmentSource,
				isAttachmentRawIndexEnabled,
				isAttachmentSharingEnabled,
				isRawBackedMessage,
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
			export { decodeBase64Content, normalizeAttachmentContent } from "./src/lib/email/attachment-content-utils.ts";
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

for (const migrated of [false, true]) {
	test(`the storage report counts shared objects once and finds missing ones ${migrated ? "after" : "before"} 0088`, async () => {
		const { env, bucket, database } = await setup({ migrated });
		const [original] = await m.storeMessageAttachments(env, "msg-in", [
			{ filename: "a.txt", type: "text/plain", content: encoder.encode("12345").buffer },
		]);
		await m.copyMessageAttachments(env, "msg-in", "msg-draft");
		const raw = migrated
			? await rawFixture(env, database, "related inside alternative inside mixed, with an inline cid image")
			: [];
		const counts = await m.getAttachmentStorageCounts(env);
		assert.deepEqual(counts.objects, {
			rows: 2,
			keys: migrated ? 1 : 2,
			bytes: 10,
			storedBytes: migrated ? 5 : 10,
		});
		assert.deepEqual(counts.raw, {
			rows: raw.length,
			bytes: raw.reduce((total, row) => total + row.size, 0),
		});
		assert.deepEqual((await m.verifyAttachmentObjects(env)).missing, []);
		await bucket.delete(original.r2Key);
		const { checked, missing } = await m.verifyAttachmentObjects(env);
		assert.equal(checked, migrated ? 1 : 2);
		assert.deepEqual(
			missing.map((entry) => ({ ...entry, messageIds: entry.messageIds.sort() })),
			[{ key: original.r2Key, messageIds: migrated ? ["msg-draft", "msg-in"] : ["msg-in"] }],
		);
	});
}

test("ATTACHMENT_SHARING=off makes sends and forwards write their own copies", async () => {
	for (const value of [undefined, "", "on", "1"]) assert.ok(m.isAttachmentSharingEnabled(value), String(value));
	for (const value of ["off", "0", "false", "no", " OFF "]) assert.ok(!m.isAttachmentSharingEnabled(value), value);
	const { env, database } = await setup();
	env.ATTACHMENT_SHARING = "off";
	const [original] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "a.txt", type: "text/plain", content: encoder.encode("own copy").buffer },
	]);
	const [forwarded] = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
	assert.notEqual(keyOf(database, forwarded.id), original.r2Key);
	const [sent] = await m.storeMessageAttachments(
		env,
		"msg-sent",
		await m.loadMessageAttachmentContents(env, "msg-draft"),
	);
	assert.notEqual(sent.r2Key, keyOf(database, forwarded.id));
	const raws = await rawFixture(env, database, "related inside alternative inside mixed, with an inline cid image");
	database.db.exec("DELETE FROM message_attachments WHERE message_id IN ('msg-draft', 'msg-sent')");
	const first = await m.copyMessageAttachments(env, "msg-in", "msg-draft");
	const second = await m.copyMessageAttachments(env, "msg-in", "msg-sent");
	assert.equal(first.length, raws.length + 1);
	const firstKeys = new Set(keysOf(database, "msg-draft"));
	assert.ok(
		keysOf(database, "msg-sent").every((key) => !firstKeys.has(key)),
		"no digest reuse either",
	);
	assert.equal(second.length, first.length);
});

test("a forward that fails part way removes its copies, never the original's files", async () => {
	const { env, bucket, database } = await setup();
	const raws = await rawFixture(env, database, "related inside alternative inside mixed, with an inline cid image");
	assert.equal(raws.length, 2);
	const put = bucket.put.bind(bucket);
	let puts = 0;
	bucket.put = async (...args) => {
		if (++puts === 2) throw new Error("storage down");
		return put(...args);
	};
	await assert.rejects(
		silenced(() => m.copyMessageAttachments(env, "msg-in", "msg-draft")),
		/storage down/,
	);
	bucket.put = put;
	assert.deepEqual(keysOf(database, "msg-draft"), [], "no copied row stays on the draft");
	assert.equal(puts, 2);
	assert.equal((await m.getAttachmentStorageCounts(env)).objects.keys, 0);
	for (const row of raws) assert.deepEqual(bytesOf(await m.readAttachmentBytes(env, row)), row.content);
});

// docs/specs/attachments-once.md §8 step 4: received and imported mail stores verified attachments as 'raw' rows.

const fixtureRaw = (name) => encoder.encode(FIXTURES.find((fixture) => fixture.name === name).raw);
const storageOf = (database, messageId) =>
	database.db
		.prepare(
			"SELECT storage, r2_key AS r2Key, raw_offset AS rawOffset, sha256 FROM message_attachments WHERE message_id = ? ORDER BY rowid",
		)
		.all(messageId);

/** Stores a fixture's attachments the way inbound delivery does: the raw at its key, then the rows with `raw`. */
async function ingest(env, fixtureName, { key = "inbound/1-msg.eml", status = "received", messageId = "msg-in" } = {}) {
	const raw = fixtureRaw(fixtureName);
	await env.BUCKET.put(key, raw);
	const parsed = await m.parseRawMime(raw.buffer);
	const stored = await m.storeMessageAttachments(env, messageId, parsed.attachments, {
		validate: false,
		raw: { key, bytes: raw.buffer, status },
	});
	return { parsed, stored };
}

const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

test("utils: attachment content from every form a body or the parser hands over", () => {
	const text = (buffer) => new TextDecoder().decode(buffer);
	assert.equal(text(m.decodeBase64Content("aGVs\r\nbG8=")), "hello");
	const buffer = encoder.encode("as is").buffer;
	assert.equal(m.normalizeAttachmentContent(buffer), buffer);
	// A view into a larger buffer gives exactly its own bytes.
	const view = encoder.encode("xxinsidexx").subarray(2, 8);
	assert.equal(text(m.normalizeAttachmentContent(view)), "inside");
	assert.equal(text(m.normalizeAttachmentContent("aGk=", "base64")), "hi");
	assert.equal(text(m.normalizeAttachmentContent("café", "utf8")), "café");
	assert.equal(text(m.normalizeAttachmentContent("plain")), "plain");
});

test("utils: the raw-index switch and which messages may hold 'raw' rows", () => {
	assert.ok(m.isAttachmentRawIndexEnabled(undefined));
	assert.ok(m.isAttachmentRawIndexEnabled("on"));
	for (const off of ["off", "0", "false", " NO "]) assert.ok(!m.isAttachmentRawIndexEnabled(off), off);
	assert.ok(m.isRawBackedMessage({ rawKey: "inbound/1-a.eml", status: "received" }));
	assert.ok(m.isRawBackedMessage({ rawKey: "imports/msg.eml", status: "spam" }));
	assert.ok(m.isRawBackedMessage({ rawKey: "inbound/1-a.eml", status: "screening" }));
	assert.ok(!m.isRawBackedMessage({ rawKey: "imports/msg.eml", status: "draft" }));
	assert.ok(!m.isRawBackedMessage({ rawKey: "drafts/msg.eml", status: "sent" }));
	assert.ok(!m.isRawBackedMessage({ rawKey: "external/acc/1/2.eml", status: "received" }));
	assert.ok(!m.isRawBackedMessage({ rawKey: null, status: "received" }));
});

test("utils: the repair source must be unambiguous", () => {
	const file = (filename, text, contentId = null) => ({
		filename,
		type: "application/pdf",
		content: encoder.encode(text).buffer,
		contentId,
	});
	const row = { filename: "a.pdf", size: 3, contentId: null };
	assert.equal(m.findAttachmentSource(row, [file("b.pdf", "abc"), file("a.pdf", "abc")]).filename, "a.pdf");
	assert.equal(m.findAttachmentSource(row, [file("a.pdf", "abcd")]), null);
	assert.equal(m.findAttachmentSource(row, [file("a.pdf", "abc", "<x>")]), null);
	// Two files with the same name and size but other bytes: which one the row was is unknown.
	assert.equal(m.findAttachmentSource(row, [file("a.pdf", "abc"), file("a.pdf", "xyz")]), null);
	assert.ok(m.findAttachmentSource(row, [file("a.pdf", "abc"), file("a.pdf", "abc")]));
	// The stored name is the sanitised one.
	assert.ok(m.findAttachmentSource({ ...row, filename: "x_a.pdf" }, [file("x/a.pdf", "abc")]));
});

test("inbound ingest stores verified attachments as 'raw' rows and writes no object for them", async () => {
	const { env, database, bucket } = await setup();
	const { parsed, stored } = await ingest(env, "related inside alternative inside mixed, with an inline cid image");
	assert.equal(stored.length, 2);
	const rows = storageOf(database, "msg-in");
	assert.deepEqual(
		rows.map((row) => row.storage),
		["raw", "raw"],
	);
	for (const [index, row] of rows.entries()) {
		assert.equal(row.r2Key, m.rawAttachmentKey(stored[index].id));
		assert.equal(stored[index].r2Key, row.r2Key);
		assert.equal(row.sha256, await sha256(parsed.attachments[index].content));
		const read = await m.readAttachmentBytes(env, { ...stored[index], contentType: stored[index].type });
		assert.deepEqual(bytesOf(read), bytesOf(parsed.attachments[index].content));
	}
	assert.ok(!existsSync(join(bucket.root, "attachments")), "no attachment object was written");
	// The list and the forward path see them like any other attachment.
	assert.deepEqual(
		(await m.listMessageAttachments(env, "msg-in")).map((row) => row.size),
		parsed.attachments.map((attachment) => attachment.content.byteLength),
	);
});

test("quoted-printable and uuencode attachments fall back to objects of their own", async () => {
	const { env, database } = await setup();
	const { parsed, stored } = await ingest(env, "quoted-printable and uuencode attachments");
	assert.ok(stored.length >= 1);
	const rows = storageOf(database, "msg-in");
	assert.ok(rows.every((row) => row.storage === "object" && !m.isRawAttachmentKey(row.r2Key)));
	for (const [index, row] of stored.entries()) {
		const read = await m.readAttachmentBytes(env, { ...row, contentType: row.type });
		assert.deepEqual(bytesOf(read), bytesOf(parsed.attachments[index].content));
	}
});

test("a message mixing a base64 part and a quoted-printable part stores one of each", async () => {
	const { env, database } = await setup();
	const boundary = "mix";
	const pdf = Buffer.from("%PDF-1.4 mixed fixture body that is long enough to wrap the lines nicely");
	const raw = [
		"From: a@example.com",
		"To: b@example.com",
		"Subject: Mixed",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain",
		"",
		"Body",
		`--${boundary}`,
		'Content-Type: application/pdf; name="a.pdf"',
		'Content-Disposition: attachment; filename="a.pdf"',
		"Content-Transfer-Encoding: base64",
		"",
		...(pdf.toString("base64").match(/.{1,76}/g) ?? []),
		`--${boundary}`,
		'Content-Type: text/plain; name="notes.txt"',
		'Content-Disposition: attachment; filename="notes.txt"',
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"caf=C3=A9 =3D notes",
		`--${boundary}--`,
		"",
	].join("\r\n");
	const bytes = encoder.encode(raw);
	await env.BUCKET.put("inbound/1-msg.eml", bytes);
	const parsed = await m.parseRawMime(bytes.buffer);
	await m.storeMessageAttachments(env, "msg-in", parsed.attachments, {
		raw: { key: "inbound/1-msg.eml", bytes: bytes.buffer, status: "received" },
	});
	assert.deepEqual(
		storageOf(database, "msg-in").map((row) => row.storage),
		["raw", "object"],
	);
	const [pdfRow, notesRow] = await m.loadMessageAttachmentContents(env, "msg-in");
	assert.deepEqual(bytesOf(pdfRow.content), bytesOf(pdf));
	assert.equal(new TextDecoder().decode(notesRow.content).trim(), "café = notes");
});

test("drafts, JMAP and synced raws, the kill switch and a schema without 0088 keep writing objects", async () => {
	const name = "multipart/mixed";
	const cases = [
		{ label: "an imported draft", options: { key: "imports/msg-in.eml", status: "draft" } },
		{ label: "a JMAP drafts/ raw", options: { key: "drafts/msg-in.eml", status: "received" } },
		{ label: "a synced external/ raw", options: { key: "external/acc/1/2.eml", status: "received" } },
		{ label: "ATTACHMENT_RAW_INDEX=off", options: {}, env: { ATTACHMENT_RAW_INDEX: "off" } },
		{ label: "before migration 0088", options: {}, migrated: false },
	];
	for (const item of cases) {
		const { env, database } = await setup({ migrated: item.migrated ?? true });
		Object.assign(env, item.env ?? {});
		const { parsed, stored } = await ingest(env, name, item.options);
		const keys = keysOf(database, "msg-in");
		assert.equal(keys.length, parsed.attachments.length, item.label);
		assert.ok(
			keys.every((key) => !m.isRawAttachmentKey(key)),
			item.label,
		);
		const [read] = await m.loadMessageAttachmentContents(env, "msg-in");
		assert.deepEqual(bytesOf(read.content), bytesOf(parsed.attachments[0].content), item.label);
		assert.equal(stored.length, parsed.attachments.length, item.label);
	}
});

test("imported mail stores 'raw' rows too", async () => {
	const { env, database } = await setup();
	database.db.exec("UPDATE messages SET raw_r2_key = 'imports/msg-in.eml' WHERE id = 'msg-in'");
	await ingest(env, "two identical attachments", { key: "imports/msg-in.eml", status: "archived" });
	const rows = storageOf(database, "msg-in");
	assert.deepEqual(
		rows.map((row) => row.storage),
		["raw", "raw"],
	);
	// Two identical files take two parts, never the same range twice.
	assert.notEqual(rows[0].rawOffset, rows[1].rawOffset);
});

test("lazy repair: an 'object' row whose object is gone is served from the raw and becomes 'raw'", async () => {
	const { env, database, bucket } = await setup();
	const raw = fixtureRaw("multipart/mixed");
	await bucket.put("inbound/1-msg.eml", raw);
	const parsed = await m.parseRawMime(raw.buffer);
	// Stored as objects (a backup from before the reclaim), then the objects are lost.
	const [stored] = await m.storeMessageAttachments(env, "msg-in", parsed.attachments, { validate: false });
	await bucket.delete(stored.r2Key);
	const row = { ...stored, contentType: stored.type };
	const opened = await silenced(() => m.openAttachment(env, row));
	assert.deepEqual(bytesOf(await new Response(opened.body).arrayBuffer()), bytesOf(parsed.attachments[0].content));
	const [after] = storageOf(database, "msg-in");
	assert.equal(after.storage, "raw");
	assert.equal(after.r2Key, m.rawAttachmentKey(stored.id));
	// Read again through the stored row: the new layout.
	const [listed] = await m.loadMessageAttachmentContents(env, "msg-in");
	assert.deepEqual(bytesOf(listed.content), bytesOf(parsed.attachments[0].content));
});

test("lazy repair puts the object back when 'raw' rows are off, and gives up without a matching file", async () => {
	const { env, database, bucket } = await setup();
	env.ATTACHMENT_RAW_INDEX = "off";
	const raw = fixtureRaw("multipart/mixed");
	await bucket.put("inbound/1-msg.eml", raw);
	const parsed = await m.parseRawMime(raw.buffer);
	const [stored] = await m.storeMessageAttachments(env, "msg-in", parsed.attachments, { validate: false });
	await bucket.delete(stored.r2Key);
	const row = { ...stored, contentType: stored.type };
	const read = await silenced(() => m.readAttachmentBytes(env, row));
	assert.deepEqual(bytesOf(read), bytesOf(parsed.attachments[0].content));
	assert.equal(storageOf(database, "msg-in")[0].storage, "object");
	assert.ok(await bucket.get(stored.r2Key), "the object is back under its own key");

	// A row the raw does not hold (renamed here) stays missing rather than being served another file.
	database.db.exec(`UPDATE message_attachments SET filename = 'other.pdf' WHERE id = '${stored.id}'`);
	await bucket.delete(stored.r2Key);
	assert.equal(await silenced(() => m.readAttachmentBytes(env, row)), null);
	// A draft never repairs from a raw.
	database.db.exec("UPDATE messages SET status = 'draft' WHERE id = 'msg-in'");
	database.db.exec(`UPDATE message_attachments SET filename = '${stored.filename}' WHERE id = '${stored.id}'`);
	assert.equal(await silenced(() => m.openAttachment(env, row)), null);
});

test("a 'raw' row whose range no longer decodes to its bytes is materialized, never served wrong", async () => {
	const { env, database, bucket } = await setup();
	const { parsed, stored } = await ingest(env, "multipart/mixed");
	const row = { ...stored[0], contentType: stored[0].type };
	// A wrong range (as a scanner bug would leave): the buffered read checks the digest and repairs from the raw.
	database.db.exec(`UPDATE message_attachments SET raw_offset = raw_offset + 4 WHERE id = '${row.id}'`);
	const read = await silenced(() => m.readAttachmentBytes(env, row));
	assert.deepEqual(bytesOf(read), bytesOf(parsed.attachments[0].content));
	const [after] = storageOf(database, "msg-in");
	assert.equal(after.storage, "object");
	assert.ok(!m.isRawAttachmentKey(after.r2Key));
	assert.ok(await bucket.get(after.r2Key));

	// A raw whose file changed cannot be verified against the recorded digest: nothing is returned.
	const second = await setup();
	const again = await ingest(second.env, "multipart/mixed");
	const other = { ...again.stored[0], contentType: again.stored[0].type };
	second.database.db.exec(`UPDATE message_attachments SET sha256 = '${"0".repeat(64)}' WHERE id = '${other.id}'`);
	assert.equal(await silenced(() => m.readAttachmentBytes(second.env, other)), null);
	assert.equal(storageOf(second.database, "msg-in")[0].storage, "raw");
});

test("materializing a mismatched 'raw' row writes a fresh key and never removes an object a forward names", async () => {
	const { env, database, bucket } = await setup();
	const { parsed, stored } = await ingest(env, "multipart/mixed");
	const row = { ...stored[0], contentType: stored[0].type };
	// The row's own key is still named by a forward made before the file became raw-backed.
	const ownKey = `attachments/msg-in/${row.id}`;
	await bucket.put(ownKey, parsed.attachments[0].content);
	database.db.exec(
		`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
			VALUES ('att-forward', 'msg-draft', '${row.filename}', '${row.type}', ${row.size}, '${ownKey}', 1)`,
	);
	database.db.exec(`UPDATE message_attachments SET raw_offset = raw_offset + 4 WHERE id = '${row.id}'`);
	// The message is deleted while the repair writes its copy: the UPDATE matches nothing.
	const put = bucket.put.bind(bucket);
	const written = [];
	bucket.put = async (key, ...rest) => {
		const result = await put(key, ...rest);
		written.push(key);
		database.db.exec("DELETE FROM messages WHERE id = 'msg-in'");
		return result;
	};
	await silenced(() => m.readAttachmentBytes(env, row));
	assert.equal(written.length, 1);
	assert.notEqual(written[0], ownKey);
	assert.equal(await bucket.get(written[0]), null, "the unclaimed copy is removed");
	const forward = { id: "att-forward", r2Key: ownKey, size: row.size, contentType: row.type };
	assert.deepEqual(bytesOf(await m.readAttachmentBytes(env, forward)), bytesOf(parsed.attachments[0].content));
});

/** An object row stored from the "multipart/mixed" fixture's raw, whose object is then lost. */
async function lostObjectRow(env, bucket) {
	const raw = fixtureRaw("multipart/mixed");
	await bucket.put("inbound/1-msg.eml", raw);
	const parsed = await m.parseRawMime(raw.buffer);
	const [stored] = await m.storeMessageAttachments(env, "msg-in", parsed.attachments, { validate: false });
	await bucket.delete(stored.r2Key);
	return { stored, row: { ...stored, contentType: stored.type }, content: bytesOf(parsed.attachments[0].content) };
}

test("lazy repair puts a shared missing object back instead of converting the row that shares it", async () => {
	const { env, database, bucket } = await setup();
	const { stored, row, content } = await lostObjectRow(env, bucket);
	// A forward draft made before the object was lost names the same key.
	database.db.exec(
		`INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
			VALUES ('att-forward', 'msg-draft', '${stored.filename}', '${stored.type}', ${stored.size}, '${stored.r2Key}', 1)`,
	);
	const opened = await silenced(() => m.openAttachment(env, row));
	assert.deepEqual(bytesOf(await new Response(opened.body).arrayBuffer()), content);
	assert.equal(storageOf(database, "msg-in")[0].storage, "object", "the original stays an object row");
	assert.equal(keyOf(database, stored.id), stored.r2Key);
	// The object is back, so the forward reads too.
	const forward = { id: "att-forward", r2Key: stored.r2Key, size: stored.size, contentType: stored.type };
	assert.deepEqual(bytesOf(await m.readAttachmentBytes(env, forward)), content);
});

test("lazy repair that loses the race to another conversion writes no object", async () => {
	const { env, database, bucket } = await setup();
	const { stored, row, content } = await lostObjectRow(env, bucket);
	// Another read converts the row between this repair's check and its UPDATE: the UPDATE then matches nothing.
	const db = env.DB;
	const racing = {
		...env,
		DB: new Proxy(db, {
			get(target, property) {
				if (property !== "prepare") return Reflect.get(target, property).bind?.(target) ?? target[property];
				return (sql) => {
					if (!sql.startsWith("UPDATE message_attachments SET storage = 'raw'")) return target.prepare(sql);
					return {
						bind: (...params) => ({
							run: async () => {
								await target
									.prepare(sql)
									.bind(...params)
									.run();
								return target
									.prepare(sql)
									.bind(...params)
									.run();
							},
						}),
					};
				};
			},
		}),
	};
	const read = await silenced(() => m.readAttachmentBytes(racing, row));
	assert.deepEqual(bytesOf(read), content);
	assert.equal(storageOf(database, "msg-in")[0].storage, "raw");
	assert.equal(await bucket.get(stored.r2Key), null, "no object was written for the converted row");
});

test("lazy repair refuses bytes that do not match the row's recorded digest", async () => {
	const { env, database, bucket } = await setup();
	const { stored, row } = await lostObjectRow(env, bucket);
	database.db.exec(`UPDATE message_attachments SET sha256 = '${"f".repeat(64)}' WHERE id = '${stored.id}'`);
	assert.equal(await silenced(() => m.openAttachment(env, row)), null);
	assert.equal(storageOf(database, "msg-in")[0].storage, "object");
	assert.equal(await bucket.get(stored.r2Key), null, "nothing unverified was put back");
});

test("received files that need an object record their digest, so a forward of the same bytes names it", async () => {
	const { env, database } = await setup();
	await ingest(env, "quoted-printable and uuencode attachments");
	const rows = database.db.prepare("SELECT storage, sha256 FROM message_attachments WHERE message_id = 'msg-in'").all();
	assert.ok(rows.length > 0);
	assert.ok(rows.every((item) => item.storage === "object" && /^[0-9a-f]{64}$/.test(item.sha256)));
});
