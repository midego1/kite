import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// docs/specs/attachments-once.md §5.2: only the accessor turns an attachment row into bytes. A 'raw' row's key is a
// sentinel and its bytes are a range of the whole raw message, so a reader that passed a row's key to a bucket itself
// would either 404 or, worse, serve every part and header of the message.
const ACCESSOR = "src/lib/email/attachment-storage.ts";
/** Files that may read an attachment row's `r2Key` from a bucket directly. */
const DIRECT_READ_ALLOWLIST = new Set([ACCESSOR]);
/**
 * Object-copying SQL over `message_attachments` that must leave 'raw' rows out (their bytes ride with the raw), and the
 * accessor's shares, which name another row's object and must never name a sentinel.
 */
const OBJECT_COPIERS = [
	"src/lib/backups/objects.ts",
	"src/lib/storage/migration.ts",
	"src/lib/storage/stores.ts",
	"src/lib/email/attachment-storage-report.ts",
	ACCESSOR,
];

function sourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(full));
		else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
	}
	return files;
}

const files = [...sourceFiles("src"), ...sourceFiles("server"), "worker.ts", "worker-utils.ts"].map((file) =>
	path.relative(process.cwd(), file),
);
const read = (file) => readFileSync(file, "utf8");

test("only the attachment accessor passes an attachment row's r2Key to a bucket", () => {
	assert.ok(files.length > 500, "source enumeration found too few files");
	// `backup.r2Key` is a database backup's own object, not an attachment.
	const direct = /\.get\(\s*(?!backup\b)[\w.]*\br2Key\b/;
	const offenders = files.filter((file) => !DIRECT_READ_ALLOWLIST.has(file) && direct.test(read(file)));
	assert.deepEqual(
		offenders,
		[],
		`read attachments with openAttachment or readAttachmentBytes in: ${offenders.join(", ")}`,
	);
});

test("attachment rows are read and written without the storage columns a pending migration may lack", () => {
	const wholeRow = [
		/select\(\)\s*\.from\(messageAttachments\)/,
		/:\s*messageAttachments\s*,/,
		/\.insert\(messageAttachments\)/,
	];
	const offenders = files.filter((file) => wholeRow.some((pattern) => pattern.test(read(file))));
	assert.deepEqual(
		offenders,
		[],
		`select ATTACHMENT_ROW_COLUMNS and insert with insertRow (src/lib/db/pending-columns.ts) in: ${offenders.join(", ")}`,
	);
});

test("object copies of message_attachments skip 'raw' rows", () => {
	for (const file of OBJECT_COPIERS) {
		const queries = read(file)
			.split("\n")
			.filter((line) => /FROM message_attachments/.test(line));
		assert.ok(queries.length > 0, `${file} still reads message_attachments`);
		for (const query of queries) assert.match(query, /ATTACHMENT_OBJECT_ROWS_SQL/, `${file}: ${query.trim()}`);
	}
	const others = files.filter(
		(file) =>
			!OBJECT_COPIERS.includes(file) &&
			/FROM message_attachments[^`"]*r2_key|r2_key[^`"]*FROM message_attachments/.test(read(file)),
	);
	assert.deepEqual(others, [], `filter on ATTACHMENT_OBJECT_ROWS_SQL in: ${others.join(", ")}`);
});

test("the accessor serves 'raw' rows only from their own range", () => {
	const source = read(ACCESSOR);
	assert.match(source, /eq\(messageAttachments\.storage, "raw"\)/, "a raw location requires storage = 'raw'");
	assert.match(source, /range: \{ offset: location\.offset, length: location\.length \}/);
	assert.doesNotMatch(source, /BUCKET\.get\(location\.rawKey\)/, "the whole raw message is never read for a row");
});
