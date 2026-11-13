import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 as nodeCrc32 } from "node:zlib";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { FIXTURES } from "./fixtures/mime/fixtures.mjs";

// The "Download all" archive (ported from upstream Mailflare #269): the streaming ZIP writer, the names inside it,
// and the checks before it streams, against a migrated SQLite database and the Node file bucket.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-attachments-zip-test-");
const scratch = mkdtempSync(join(tmpdir(), "kite-attachments-zip-"));
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
			export { createZipStream, toDosDateTime, zipArchiveBytes } from "./src/lib/zip/zip-stream-utils.ts";
			export { attachmentsArchiveName, uniqueZipEntryNames, zipEntryName } from "./src/lib/email/attachment-zip-utils.ts";
			export { attachmentArchiveRefusal, attachmentArchiveResponse } from "./src/lib/email/attachment-archive.ts";
			export { findMessageAttachmentsForUser, storeMessageAttachments } from "./src/lib/email/attachments.ts";
			export { isAttachmentStored } from "./src/lib/email/attachment-storage.ts";
			export { rawAttachmentKey } from "./src/lib/email/attachment-storage-utils.ts";
			export { indexMimeParts, matchAttachmentsToParts } from "./src/lib/email/mime-index-utils.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export { inspectZipDirectory, locateZipDirectory } from "./src/lib/email/attachment-risk.ts";
			export {
				archiveCheckOutcome,
				archiveFrameOutcome,
				attachmentsZipUrl,
				flaggedArchiveLines,
			} from "./src/components/download-all-attachments-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "attachments-zip-test-entry.ts",
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
const OWNER = { id: "owner", role: "user", email: "owner@example.com" };
const STRANGER = { id: "stranger", role: "user", email: "stranger@example.com" };
let counter = 0;

function streamOf(...chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function collect(stream) {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a generated archive back: each entry from the central directory, checked against its local header. */
function readZip(bytes) {
	const located = m.locateZipDirectory(bytes);
	assert.ok(located, "end of central directory found");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries = [];
	let at = located.offset;
	while (at < located.offset + located.size) {
		assert.equal(view.getUint32(at, true), 0x02014b50, "central header signature");
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const entry = {
			name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
			flags: view.getUint16(at + 8, true),
			method: view.getUint16(at + 10, true),
			crc: view.getUint32(at + 16, true),
			size: view.getUint32(at + 24, true),
			offset: view.getUint32(at + 42, true),
			extra: bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
		};
		assert.equal(view.getUint32(entry.offset, true), 0x04034b50, "local header signature");
		const localName = view.getUint16(entry.offset + 26, true);
		const localExtra = view.getUint16(entry.offset + 28, true);
		assert.deepEqual(
			[...bytes.subarray(entry.offset + 30 + localName, entry.offset + 30 + localName + localExtra)],
			[...entry.extra],
			"the same extra field in both headers",
		);
		const start = entry.offset + 30 + localName + localExtra;
		entry.data = bytes.subarray(start, start + entry.size);
		assert.equal(view.getUint32(start + entry.size, true), 0x08074b50, "data descriptor signature");
		assert.equal(view.getUint32(start + entry.size + 4, true), entry.crc, "descriptor CRC");
		assert.equal(view.getUint32(start + entry.size + 8, true), entry.size, "descriptor size");
		assert.equal(nodeCrc32(entry.data), entry.crc, `${entry.name} CRC`);
		entries.push(entry);
		at += 46 + nameLength + extraLength;
	}
	assert.equal(located.entries, entries.length);
	return entries;
}

/** `unzip -t` as an outside reader, when the machine has it. */
function unzipTest(bytes) {
	const file = join(scratch, `archive-${++counter}.zip`);
	writeFileSync(file, bytes);
	const result = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
	if (result.error) return;
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /No errors detected/);
}

test("the ZIP writer streams entries that outside readers verify", async () => {
	const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
	const opened = [];
	const stream = m.createZipStream([
		{
			name: "hello.txt",
			size: 11,
			modified: new Date(Date.UTC(2026, 10, 13, 9, 30, 10)),
			open: async () => streamOf(encoder.encode("hello world")),
		},
		{
			name: "résumé.pdf",
			size: pdf.byteLength,
			modified: new Date(0),
			open: async () => {
				opened.push("résumé.pdf");
				// Several chunks, and an empty one, exercise the running CRC.
				return streamOf(pdf.subarray(0, 2), new Uint8Array(0), pdf.subarray(2));
			},
		},
		{ name: "empty.bin", size: 0, modified: new Date(), open: async () => streamOf() },
	]);
	assert.deepEqual(opened, [], "nothing is opened before the archive is read");
	const bytes = await collect(stream);
	const entries = readZip(bytes);
	assert.deepEqual(
		entries.map((entry) => entry.name),
		["hello.txt", "résumé.pdf", "empty.bin"],
	);
	assert.equal(new TextDecoder().decode(entries[0].data), "hello world");
	assert.deepEqual([...entries[1].data], [...pdf]);
	assert.equal(entries[2].size, 0);
	// The extended timestamp: "UT", 5 bytes, modification time set, the Unix seconds.
	const ut = new DataView(entries[0].extra.buffer, entries[0].extra.byteOffset, entries[0].extra.byteLength);
	assert.equal(entries[0].extra.byteLength, 9);
	assert.equal(ut.getUint16(0, true), 0x5455);
	assert.equal(ut.getUint16(2, true), 5);
	assert.equal(ut.getUint8(4), 1);
	assert.equal(ut.getUint32(5, true), Date.UTC(2026, 10, 13, 9, 30, 10) / 1000);
	for (const entry of entries) {
		assert.equal(entry.method, 0, "stored");
		assert.equal(entry.flags, 0x0808, "data descriptor and UTF-8 names");
	}
	assert.equal(
		m.zipArchiveBytes(entries.map((entry) => ({ name: entry.name, size: entry.size }))),
		bytes.byteLength,
		"the size estimate is exact",
	);
	// Kite's own risk check reads the directory it wrote.
	const located = m.locateZipDirectory(bytes);
	const directoryBytes = bytes.subarray(located.offset, located.offset + located.size);
	assert.equal(m.inspectZipDirectory(located, directoryBytes).level, "ok");
	unzipTest(bytes);
});

test("the ZIP writer writes an empty archive, refuses what plain ZIP cannot hold and fails instead of skipping", async () => {
	const empty = await collect(m.createZipStream([]));
	assert.equal(empty.byteLength, 22);
	assert.deepEqual(readZip(empty), []);
	assert.equal(m.zipArchiveBytes([{ name: "big.bin", size: 2 ** 32 }]), null);
	assert.equal(m.zipArchiveBytes(Array.from({ length: 65_536 }, () => ({ name: "a", size: 0 }))), null);
	assert.equal(m.zipArchiveBytes([]), 22);

	const failing = m.createZipStream([
		{ name: "a.txt", size: 1, modified: new Date(), open: async () => streamOf(encoder.encode("a")) },
		{ name: "gone.txt", size: 1, modified: new Date(), open: async () => Promise.reject(new Error("gone")) },
	]);
	await assert.rejects(collect(failing), /gone/);
	await assert.rejects(
		collect(m.createZipStream([{ name: "", size: 0, modified: new Date(), open: async () => streamOf() }])),
		/Invalid file name/,
	);
	await assert.rejects(
		collect(m.createZipStream([{ name: "a", size: -1, modified: new Date(), open: async () => streamOf() }])),
		/Invalid file size/,
	);
	await assert.rejects(
		collect(
			m.createZipStream(
				Array.from({ length: 65_536 }, () => ({
					name: "a",
					size: 0,
					modified: new Date(),
					open: async () => streamOf(),
				})),
			),
		),
		/Too many files/,
	);
});

test("a file shorter or longer than its stored size, or failing partway, fails the archive", async () => {
	const archive = (size, body) =>
		collect(m.createZipStream([{ name: "report.pdf", size, modified: new Date(), open: async () => body }]));
	// One byte short: without the check this would be a valid archive holding a truncated file.
	await assert.rejects(archive(5, streamOf(encoder.encode("%PDF"))), /not the size it was stored with/);
	await assert.rejects(archive(3, streamOf(encoder.encode("%P"), encoder.encode("DF"))), /not the size/);
	let sent = false;
	const breaking = new ReadableStream({
		pull(controller) {
			if (sent) return controller.error(new Error("storage read failed"));
			sent = true;
			controller.enqueue(encoder.encode("%P"));
		},
	});
	await assert.rejects(archive(4, breaking), /storage read failed/);
	// The exact size still works.
	assert.equal(readZip(await archive(4, streamOf(encoder.encode("%PDF"))))[0].size, 4);
});

test("cancelling the download stops reading the open attachment", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	const reader = m
		.createZipStream([{ name: "endless.bin", size: 2 ** 31, modified: new Date(), open: async () => body }])
		.getReader();
	for (let index = 0; index < 4; index += 1) await reader.read();
	await reader.cancel();
	assert.equal(cancelled, true);
});

test("MS-DOS times are written in UTC and clamp to the format's years", () => {
	assert.deepEqual(m.toDosDateTime(new Date(Date.UTC(2026, 10, 13, 9, 30, 11))), {
		dosTime: (9 << 11) | (30 << 5) | 5,
		dosDate: ((2026 - 1980) << 9) | (11 << 5) | 13,
	});
	assert.equal(m.toDosDateTime(new Date(0)).dosDate, (0 << 9) | (1 << 5) | 1);
	assert.equal(m.toDosDateTime(new Date(Date.UTC(2200, 0, 1))).dosDate >> 9, 127);
});

test("names inside the archive cannot leave its folder, collide or break extraction", () => {
	const RLO = String.fromCharCode(0x202e);
	assert.equal(m.zipEntryName("../../etc/passwd"), ".._.._etc_passwd");
	assert.equal(m.zipEntryName("C:\\Windows\\evil.exe"), "C__Windows_evil.exe");
	assert.equal(m.zipEntryName(`invoice${RLO}fdp.exe`), "invoicefdp.exe");
	assert.equal(m.zipEntryName('what?<now>|"*.txt'), "what__now____.txt");
	assert.equal(m.zipEntryName("notes. . "), "notes");
	assert.equal(m.zipEntryName("...."), "attachment");
	assert.equal(m.zipEntryName(""), "attachment");
	assert.equal(m.zipEntryName("CON.txt"), "_CON.txt");
	assert.equal(m.zipEntryName("lpt1"), "_lpt1");
	assert.equal(m.zipEntryName("console.txt"), "console.txt");
	assert.equal(m.zipEntryName("CON .txt"), "_CON .txt");
	assert.equal(m.zipEntryName("nul. .log"), "_nul. .log");
	assert.equal(m.zipEntryName("COM¹.txt"), "_COM¹.txt");
	assert.equal(m.zipEntryName("lpt³"), "_lpt³");
	assert.equal(m.zipEntryName("com10.txt"), "com10.txt");
	assert.equal(m.zipEntryName("re\u0301sume\u0301.pdf"), "résumé.pdf", "NFC");
	assert.ok(encoder.encode(m.zipEntryName(`${"é".repeat(200)}.pdf`)).byteLength <= 180);

	assert.deepEqual(
		m.uniqueZipEntryNames(["a.pdf", "a.pdf", "A.PDF", "a (2).pdf", "notes", "notes", "b/c.txt", "b_c.txt"]),
		["a.pdf", "a (2).pdf", "A (3).PDF", "a (2) (2).pdf", "notes", "notes (2)", "b_c.txt", "b_c (2).txt"],
	);
	assert.deepEqual(m.uniqueZipEntryNames([".env", ".env"]), [".env", ".env (2)"]);
});

test("the archive is named after the subject", () => {
	assert.equal(m.attachmentsArchiveName("Q3 invoices"), "Q3 invoices.zip");
	assert.equal(m.attachmentsArchiveName("Re: files/report?  "), "Re files report.zip");
	assert.equal(m.attachmentsArchiveName("backup.zip"), "backup.zip");
	assert.equal(m.attachmentsArchiveName("..."), "attachments.zip");
	assert.equal(m.attachmentsArchiveName(""), "attachments.zip");
	assert.equal(m.attachmentsArchiveName(null), "attachments.zip");
	assert.equal(m.attachmentsArchiveName("NUL"), "attachments.zip");
	assert.ok(encoder.encode(m.attachmentsArchiveName("ü".repeat(100))).byteLength <= 84);
});

test("the reader's button reads the check's answer and builds its links", () => {
	assert.equal(m.attachmentsZipUrl("msg 1"), "/api/messages/msg%201/attachments/zip");
	assert.equal(m.attachmentsZipUrl("m", { check: true }), "/api/messages/m/attachments/zip?check=1");
	assert.equal(m.attachmentsZipUrl("m", { acknowledge: true }), "/api/messages/m/attachments/zip?acknowledge=1");
	const flagged = [
		{ id: "1", filename: "setup.exe", risk: { level: "danger", reasons: ["It is a program.", "Another"] } },
		{ id: "2", filename: "page.html", risk: { level: "warning", reasons: [] } },
	];
	assert.equal(m.flaggedArchiveLines(flagged), "• setup.exe: It is a program.\n• page.html");
	const RLO = String.fromCharCode(0x202e);
	assert.equal(
		m.flaggedArchiveLines([
			{ id: "3", filename: `inv${RLO}fdp.exe`, risk: { level: "danger", reasons: [`x${RLO}y`] } },
		]),
		"• invfdp.exe: xy",
		"no bidi characters in the warning",
	);
	assert.deepEqual(m.archiveCheckOutcome(404, { missing: [{ id: "1", filename: `a${RLO}b.pdf` }] }), {
		kind: "missing",
		filenames: ["ab.pdf"],
	});
	// The hidden download frame sees the refusal's body only.
	assert.deepEqual(
		m.archiveFrameOutcome(JSON.stringify({ code: "ATTACHMENT_MISSING", missing: [{ filename: "a.pdf" }] })),
		{
			kind: "missing",
			filenames: ["a.pdf"],
		},
	);
	assert.deepEqual(m.archiveFrameOutcome(JSON.stringify({ code: "TOO_LARGE" })), { kind: "too-large" });
	assert.deepEqual(m.archiveFrameOutcome(JSON.stringify({ code: "ATTACHMENT_RISK", flagged })), { kind: "failed" });
	assert.deepEqual(m.archiveFrameOutcome(JSON.stringify({ error: "Unauthorized" })), { kind: "failed" });
	assert.deepEqual(m.archiveFrameOutcome(JSON.stringify(null)), { kind: "failed" });
	assert.deepEqual(m.archiveFrameOutcome("<html>Bad gateway</html>"), { kind: "failed" });
	assert.deepEqual(m.archiveCheckOutcome(200, { count: 2 }), { kind: "download" });
	assert.deepEqual(m.archiveCheckOutcome(409, { flagged }), { kind: "confirm", flagged });
	assert.deepEqual(m.archiveCheckOutcome(409, { flagged: [] }), { kind: "failed" });
	assert.deepEqual(m.archiveCheckOutcome(404, { missing: [{ id: "1", filename: "a.pdf" }] }), {
		kind: "missing",
		filenames: ["a.pdf"],
	});
	assert.deepEqual(m.archiveCheckOutcome(404, { error: "Not found" }), { kind: "failed" });
	assert.deepEqual(m.archiveCheckOutcome(413, null), { kind: "too-large" });
	assert.deepEqual(m.archiveCheckOutcome(500, "oops"), { kind: "failed" });
});

async function setup() {
	const database = new m.SqliteDatabase(":memory:");
	await m.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('stranger', 'stranger@example.com', 'hash', 'Stranger', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'support', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
			VALUES ('msg-in', 'owner', 'mailbox-a', 'inbound', 'sender@example.com', 'support@example.com', 'Quarterly files', 'received', 'inbound/1-msg.eml', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
			VALUES ('msg-other-draft', 'stranger', 'mailbox-a', 'outbound', 'support@example.com', 'reader@example.com', 'Draft', 'draft', 1);
	`);
	const bucket = new m.FileBucket(join(scratch, `bucket-${++counter}`));
	return { database, bucket, env: { DB: database, BUCKET: bucket } };
}

async function archiveOf(env, messageId) {
	const found = await m.findMessageAttachmentsForUser(env, OWNER, messageId);
	const response = m.attachmentArchiveResponse(env, messageId, found.subject, found.attachments);
	const bytes = await collect(response.body);
	return { response, entries: readZip(bytes), archiveBytes: bytes.byteLength };
}

test("Download all zips a message's stored attachments for a reader, and nobody else", async () => {
	const { env } = await setup();
	await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "report.pdf", type: "application/pdf", content: encoder.encode("%PDF one").buffer },
		{ filename: "report.pdf", type: "application/pdf", content: encoder.encode("%PDF two").buffer },
		{ filename: "notes.txt", type: "text/plain", content: encoder.encode("notes").buffer },
	]);
	assert.equal(await m.findMessageAttachmentsForUser(env, STRANGER, "msg-in"), null, "no mailbox access");
	assert.equal(await m.findMessageAttachmentsForUser(env, OWNER, "msg-other-draft"), null, "another user's draft");
	assert.equal(await m.findMessageAttachmentsForUser(env, OWNER, "missing"), null);

	const found = await m.findMessageAttachmentsForUser(env, OWNER, "msg-in");
	assert.equal(found.subject, "Quarterly files");
	assert.equal(await m.attachmentArchiveRefusal(env, found.attachments, false), null);
	const { response, entries, archiveBytes } = await archiveOf(env, "msg-in");
	assert.equal(response.headers.get("content-type"), "application/zip");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(Number(response.headers.get("content-length")), archiveBytes, "the exact archive size up front");
	assert.match(response.headers.get("content-disposition"), /^attachment; filename="Quarterly files\.zip"/);
	assert.deepEqual(
		entries.map((entry) => [entry.name, new TextDecoder().decode(entry.data)]),
		[
			["report.pdf", "%PDF one"],
			["report (2).pdf", "%PDF two"],
			["notes.txt", "notes"],
		],
		"in the order the reader lists them",
	);
});

test("a missing file fails the check with 404 and a flagged one asks for the acknowledgement", async () => {
	const { env, bucket } = await setup();
	const [setup_, notes, gone] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "setup.exe", type: "application/octet-stream", content: encoder.encode("MZ").buffer },
		{ filename: "notes.txt", type: "text/plain", content: encoder.encode("notes").buffer },
		{ filename: "gone.pdf", type: "application/pdf", content: encoder.encode("%PDF").buffer },
	]);
	const { attachments } = await m.findMessageAttachmentsForUser(env, OWNER, "msg-in");

	const flagged = await m.attachmentArchiveRefusal(env, attachments, false);
	assert.equal(flagged.status, 409);
	const body = await flagged.json();
	assert.equal(body.code, "ATTACHMENT_RISK");
	assert.deepEqual(
		body.flagged.map((file) => [file.id, file.filename, file.risk.level]),
		[[setup_.id, "setup.exe", "danger"]],
	);
	assert.equal(await m.attachmentArchiveRefusal(env, attachments, true), null, "acknowledged");

	await bucket.delete(gone.r2Key);
	assert.equal(await m.isAttachmentStored(env, gone), false);
	assert.equal(await m.isAttachmentStored(env, notes), true);
	for (const acknowledged of [false, true]) {
		const missing = await m.attachmentArchiveRefusal(env, attachments, acknowledged);
		assert.equal(missing.status, 404, "a missing file is reported before the risk");
		const answer = await missing.json();
		assert.equal(answer.code, "ATTACHMENT_MISSING");
		assert.deepEqual(answer.missing, [{ id: gone.id, filename: "gone.pdf" }]);
	}

	// Gone after the check: the download errors rather than leaving the file out.
	const response = m.attachmentArchiveResponse(env, "msg-in", null, attachments);
	assert.match(response.headers.get("content-disposition"), /filename="attachments\.zip"/);
	await assert.rejects(collect(response.body), /went missing or changed/);
});

test("an older row's hidden characters never reach the refusal, and a file replaced by a shorter one fails", async () => {
	const { env, database, bucket } = await setup();
	const RLO = String.fromCharCode(0x202e);
	const [program, notes] = await m.storeMessageAttachments(env, "msg-in", [
		{ filename: "invoice.exe", type: "application/octet-stream", content: encoder.encode("MZ").buffer },
		{ filename: "notes.txt", type: "text/plain", content: encoder.encode("notes").buffer },
	]);
	// Stored before names were cleaned at ingest.
	database.db
		.prepare("UPDATE message_attachments SET filename = ? WHERE id = ?")
		.run(`invoice${RLO}fdp.exe`, program.id);
	const { attachments } = await m.findMessageAttachmentsForUser(env, OWNER, "msg-in");
	const body = await (await m.attachmentArchiveRefusal(env, attachments, false)).json();
	assert.deepEqual(
		body.flagged.map((file) => file.filename),
		["invoicefdp.exe"],
	);
	assert.ok(!JSON.stringify(body).includes(RLO), "no bidi override anywhere in the answer");

	await bucket.put(notes.r2Key, encoder.encode("note"));
	const response = m.attachmentArchiveResponse(env, "msg-in", null, attachments);
	await assert.rejects(collect(response.body), /went missing or changed/);
});

test("attachments kept inside the raw message are checked and zipped from it", async () => {
	const { env, database, bucket } = await setup();
	const raw = encoder.encode(FIXTURES.find((fixture) => fixture.name === "two identical attachments").raw);
	await bucket.put("inbound/1-msg.eml", raw);
	const parsed = await m.parseRawMime(raw.buffer);
	const { matches } = m.matchAttachmentsToParts(raw, parsed.attachments, m.indexMimeParts(raw));
	assert.ok(matches.length >= 2, "the fixture has two verified parts");
	const insert = database.db.prepare(
		`INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, content_id, r2_key,
			storage, raw_offset, raw_length, transfer_encoding, created_at)
		VALUES (?, 'msg-in', ?, ?, ?, ?, ?, ?, 'raw', ?, ?, ?, 1)`,
	);
	const expected = matches.map(({ attachmentIndex, part }, index) => {
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
		return new Uint8Array(attachment.content);
	});
	const { attachments } = await m.findMessageAttachmentsForUser(env, OWNER, "msg-in");
	assert.equal(await m.attachmentArchiveRefusal(env, attachments, true), null);
	const { entries } = await archiveOf(env, "msg-in");
	assert.equal(new Set(entries.map((entry) => entry.name.toLowerCase())).size, entries.length, "unique names");
	assert.deepEqual(
		entries.map((entry) => [...entry.data]),
		expected.map((bytes) => [...bytes]),
	);

	await bucket.delete("inbound/1-msg.eml");
	const missing = await m.attachmentArchiveRefusal(env, attachments, true);
	assert.equal(missing.status, 404);
});
