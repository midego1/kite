import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const risk = await bundleModules("kite-attachment-risk-", [
	[
		"assessAttachmentRisk, inspectZipDirectory, isExecutableFilename, isWebPageFilename, hasDecoyExtension, isZipAttachment, locateZipDirectory, mergeRisks, needsRiskReview, stripHiddenCharacters",
		"src/lib/email/attachment-risk.ts",
	],
	["assessStoredAttachment, attachmentDownloadGate", "src/lib/email/attachment-risk-store.ts"],
	["attachmentObjectKey, sanitizeFilename, truncateFilename", "src/lib/email/attachment-name-utils.ts"],
	["getContentDisposition", "src/lib/http/content-disposition-utils.ts"],
]);

const RLO = String.fromCharCode(0x202e);
const encoder = new TextEncoder();

/** A minimal ZIP: only the central directory and the end record matter to the inspector. */
function zip(names, { encrypted = false, prefix = 0 } = {}) {
	const entries = names.map((name) => {
		const nameBytes = Buffer.from(name);
		const entry = Buffer.alloc(46 + nameBytes.length);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(encrypted ? 1 : 0, 8);
		entry.writeUInt16LE(nameBytes.length, 28);
		nameBytes.copy(entry, 46);
		return entry;
	});
	const directory = Buffer.concat(entries);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(names.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(prefix, 16);
	return new Uint8Array(Buffer.concat([Buffer.alloc(prefix), directory, end]));
}

/** A bucket over one object that serves ranged reads and records them. */
function bucketOf(bytes) {
	const reads = [];
	return {
		reads,
		BUCKET: {
			async get(_key, options) {
				const range = options?.range;
				reads.push(range);
				let slice = bytes;
				if (range?.suffix != null) slice = bytes.subarray(Math.max(bytes.length - range.suffix, 0));
				else if (range) slice = bytes.subarray(range.offset, range.offset + range.length);
				return { arrayBuffer: async () => slice.slice().buffer };
			},
		},
	};
}

function stream() {
	let cancelled = false;
	return {
		get cancelled() {
			return cancelled;
		},
		body: new ReadableStream({
			cancel() {
				cancelled = true;
			},
		}),
	};
}

test("programs, macro documents and disguised names are dangerous, plain documents are not", () => {
	for (const filename of [
		"setup.exe",
		"run.JS",
		"invoice.pdf.exe",
		"report.docm",
		"photo.jpg.scr",
		`invoice${RLO}fdp.exe`,
		`notes${RLO}txt.pdf`,
		"shortcut.lnk",
		"tool.exe. ",
	]) {
		assert.equal(risk.assessAttachmentRisk({ filename }).level, "danger", filename);
	}
	for (const filename of ["login.html", "files.zip", "disk.iso", "logo.svg", "backup.7z", "notes.one"]) {
		assert.equal(risk.assessAttachmentRisk({ filename }).level, "warning", filename);
	}
	assert.equal(risk.assessAttachmentRisk({ filename: "invoice.pdf.html" }).level, "danger", "a decoy web page");
	for (const filename of [
		"invoice.pdf",
		"notes.txt",
		"photo.jpeg",
		"budget.xlsx",
		"archive.2024.final.docx",
		"README",
	]) {
		assert.equal(risk.assessAttachmentRisk({ filename, type: "application/octet-stream" }).level, "ok", filename);
	}
	assert.equal(
		risk.assessAttachmentRisk({ filename: "x.bin", type: "application/x-msdownload; name=x" }).level,
		"danger",
	);
	const reasons = risk.assessAttachmentRisk({ filename: "invoice.pdf.exe" }).reasons;
	assert.ok(reasons.some((reason) => /\.exe files run programs/.test(reason)));
	assert.ok(reasons.some((reason) => /two extensions/.test(reason)));
	assert.match(risk.assessAttachmentRisk({ filename: `a${RLO}b.txt` }).reasons[0], /hidden characters/);
});

test("the spam analyzer reads the same lists", () => {
	assert.equal(risk.isExecutableFilename("Setup.EXE"), true);
	assert.equal(risk.isExecutableFilename("disk.iso"), true);
	assert.equal(risk.isExecutableFilename("invoice.pdf"), false);
	assert.equal(risk.isWebPageFilename("page.SVGZ"), true);
	assert.equal(risk.isWebPageFilename("page.txt"), false);
	assert.equal(risk.hasDecoyExtension("invoice.pdf.html"), true);
	assert.equal(risk.hasDecoyExtension("archive.2024.html"), false);
	assert.equal(risk.isZipAttachment({ filename: "x.bin", type: "application/zip" }), true);
	assert.equal(risk.needsRiskReview({ filename: "data.bin", type: "application/x-zip-compressed" }), true);
	assert.equal(risk.needsRiskReview({ filename: "invoice.pdf", type: "application/pdf" }), false);
});

test("a ZIP's names are read from its central directory", () => {
	const inspect = (bytes) => {
		const located = risk.locateZipDirectory(bytes);
		return risk.inspectZipDirectory(located, bytes.subarray(located.offset, located.offset + located.size));
	};
	const found = inspect(zip(["docs/readme.txt", "bin/setup.exe"]));
	assert.equal(found.level, "danger");
	assert.match(found.reasons[0], /Inside the archive, bin\/setup\.exe/);
	assert.equal(inspect(zip(["a.txt", "b.png", "folder/"])).level, "ok");
	assert.equal(inspect(zip(["a.txt"], { encrypted: true })).level, "warning");
	assert.equal(inspect(zip([`x${RLO}gpj.scr`])).level, "danger");
	const located = risk.locateZipDirectory(zip(["a.txt"]));
	assert.equal(risk.inspectZipDirectory(located, null).level, "warning", "an unreadable directory is not trusted");
	assert.equal(risk.inspectZipDirectory({ ...located, entries: 0xffff }, null).level, "warning", "ZIP64");
	assert.match(risk.inspectZipDirectory({ ...located, entries: 5000 }, null).reasons[0], /too many files/);
	assert.equal(risk.locateZipDirectory(new Uint8Array(100)), null, "not a zip");
});

test("merging keeps the strongest level, de-duplicates and caps the reasons", () => {
	const merged = risk.mergeRisks(
		{ level: "warning", reasons: ["a"] },
		{ level: "danger", reasons: ["b", "a"] },
		{ level: "ok", reasons: [] },
	);
	assert.deepEqual(merged, { level: "danger", reasons: ["a", "b"] });
	const many = risk.mergeRisks({ level: "warning", reasons: ["1", "2", "3", "4", "5", "6", "7"] });
	assert.equal(many.reasons.length, 5);
});

test("a stored ZIP is checked with two bounded range reads", async () => {
	const bytes = zip(["invoice.pdf", "payload.exe"], { prefix: 1000 });
	const env = bucketOf(bytes);
	const attachment = { filename: "docs.zip", contentType: "application/zip", size: bytes.length, r2Key: "k" };
	const result = await risk.assessStoredAttachment(env, attachment);
	assert.equal(result.level, "danger");
	assert.ok(result.reasons.some((reason) => reason.includes("payload.exe")));
	assert.equal(env.reads.length, 2);
	assert.deepEqual(env.reads[0], { suffix: bytes.length });
	assert.equal(env.reads[1].offset, 1000);

	const clean = zip(["a.txt"]);
	const cleanEnv = bucketOf(clean);
	const cleanRisk = await risk.assessStoredAttachment(cleanEnv, { ...attachment, size: clean.length });
	assert.equal(cleanRisk.level, "warning", "an archive keeps its general warning");
	assert.equal(cleanRisk.reasons.length, 1);

	const notZip = bucketOf(new Uint8Array(200));
	const broken = await risk.assessStoredAttachment(notZip, { ...attachment, size: 200 });
	assert.match(broken.reasons.at(-1), /could not be checked/);

	const pdf = bucketOf(new Uint8Array(10));
	assert.equal(
		(await risk.assessStoredAttachment(pdf, { ...attachment, filename: "a.pdf", contentType: "application/pdf" }))
			.level,
		"ok",
	);
	assert.equal(pdf.reads.length, 0, "only ZIP files are read");

	const failing = { BUCKET: { get: async () => Promise.reject(new Error("down")) } };
	assert.match((await risk.assessStoredAttachment(failing, attachment)).reasons.at(-1), /could not be checked/);
});

test("the download gate answers the assessment and refuses an unacknowledged flagged download", async () => {
	const env = bucketOf(new Uint8Array(0));
	const exe = { filename: "setup.exe", contentType: "application/octet-stream", size: 10, r2Key: "k" };
	const url = "https://mail.example.com/api/messages/m/attachments/a";

	const refused = stream();
	const response = await risk.attachmentDownloadGate(env, new Request(`${url}?download=1`), exe, refused, false);
	assert.equal(response.status, 409);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = await response.json();
	assert.equal(body.code, "ATTACHMENT_RISK");
	assert.equal(body.risk.level, "danger");
	assert.equal(refused.cancelled, true, "the unread body is released");

	const info = stream();
	const assessed = await risk.attachmentDownloadGate(env, new Request(`${url}?risk=1`), exe, info, true);
	assert.equal(assessed.status, 200);
	assert.equal((await assessed.json()).level, "danger");
	assert.equal(info.cancelled, true);

	assert.equal(await risk.attachmentDownloadGate(env, new Request(`${url}?acknowledge=1`), exe, stream(), false), null);
	assert.equal(await risk.attachmentDownloadGate(env, new Request(url), exe, stream(), true), null, "inline is shown");
	const pdf = { ...exe, filename: "a.pdf", contentType: "application/pdf" };
	assert.equal(await risk.attachmentDownloadGate(env, new Request(url), pdf, stream(), false), null);
});

test("object keys carry ids only", () => {
	assert.equal(risk.attachmentObjectKey("msg_1", "att_2"), "attachments/msg_1/att_2");
});

test("stored file names drop hidden characters, refuse dot names and stay under 180 bytes", () => {
	assert.equal(risk.sanitizeFilename(`invoice${RLO}fdp.exe`), "invoicefdp.exe");
	assert.equal(risk.sanitizeFilename("a\u0000b\r\n.txt"), "ab.txt");
	assert.equal(risk.sanitizeFilename("../../etc/passwd"), ".._.._etc_passwd");
	assert.equal(risk.sanitizeFilename(".."), "attachment");
	assert.equal(risk.sanitizeFilename(" . "), "attachment");
	assert.equal(risk.sanitizeFilename("   "), "attachment");
	assert.equal(risk.sanitizeFilename(String.fromCharCode(0x200f)), "attachment");
	const long = risk.sanitizeFilename(`${"é".repeat(300)}.pdf`);
	assert.ok(encoder.encode(long).byteLength <= 180, "capped");
	assert.ok(long.endsWith(".pdf"), "keeps the extension");
	assert.ok(!long.includes("\ufffd"), "never cuts inside a character");
	assert.equal(risk.truncateFilename("short.txt", 180), "short.txt");
	assert.equal(risk.stripHiddenCharacters(`a${RLO}b`), "ab");
});

test("Content-Disposition drops hidden characters and caps long names", () => {
	const value = risk.getContentDisposition(`evil${RLO}gpj.exe`, false);
	assert.equal(value, "attachment; filename=\"evilgpj.exe\"; filename*=UTF-8''evilgpj.exe");
	const long = risk.getContentDisposition(`${"日".repeat(2000)}.pdf`, false);
	assert.ok(long.length < 1200, `header stays bounded (${long.length})`);
	assert.match(long, /\.pdf$/);
	assert.equal(risk.getContentDisposition(RLO, true), "inline; filename=\"attachment\"; filename*=UTF-8''attachment");
});
