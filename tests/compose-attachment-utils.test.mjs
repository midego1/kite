import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-compose-attachments-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/compose/compose-attachment-utils.ts")],
	outfile: join(outDir, "utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { attachmentNotice, attachmentNoticeText, canPreviewEntry, safeAttachmentUrl, splitFilename, storedDownloadUrl } =
	await import(pathToFileURL(join(outDir, "utils.mjs")).href);

const THRESHOLD = 3_000_000;
const stored = (type) => ({ kind: "stored", id: "att-1", stored: { id: "att-1", filename: "f", size: 1, type } });
const local = (type) => ({ kind: "local", id: "loc-1", file: { name: "f", size: 1, type } });

test("a truncated name keeps a short extension visible", () => {
	assert.deepEqual(splitFilename("CleanShot 2026-10-28 at 21.54.17.png"), {
		base: "CleanShot 2026-10-28 at 21.54.17",
		extension: ".png",
	});
	assert.deepEqual(splitFilename("README"), { base: "README", extension: "" });
	assert.deepEqual(splitFilename(".env"), { base: ".env", extension: "" });
	assert.deepEqual(splitFilename("trailing."), { base: "trailing.", extension: "" });
	assert.deepEqual(splitFilename("archive.tar.gz"), { base: "archive.tar", extension: ".gz" });
});

test("stored files preview in the viewer's kinds, local files only as image or text", () => {
	assert.equal(canPreviewEntry(stored("application/pdf")), true);
	assert.equal(canPreviewEntry(stored("image/png")), true);
	assert.equal(canPreviewEntry(stored("application/zip")), false);
	assert.equal(canPreviewEntry(local("application/pdf")), false);
	assert.equal(canPreviewEntry(local("image/png")), true);
	assert.equal(canPreviewEntry(local("text/plain")), true);
	assert.equal(canPreviewEntry(local("")), false);
});

test("a stored file downloads through the authenticated message attachment route, a local one has no URL", () => {
	assert.equal(storedDownloadUrl(stored("image/png"), "draft-9"), "/api/messages/draft-9/attachments/att-1?download=1");
	assert.equal(storedDownloadUrl(stored("image/png"), null), null);
	assert.equal(storedDownloadUrl(local("image/png"), "draft-9"), null);
});

test("the size notice shows only when a file becomes a link or the files near the message budget", () => {
	assert.equal(attachmentNotice([52_000], THRESHOLD), null);
	assert.equal(attachmentNotice([400_000, 400_000, 400_000], THRESHOLD), null);
	assert.equal(attachmentNotice([3_000_001], THRESHOLD), "links");
	assert.equal(attachmentNotice([2_000_000, 2_000_000], THRESHOLD), "near-budget");
	assert.match(attachmentNoticeText("links", THRESHOLD), /over 3 MB are sent as 30-day R2 download links/);
	assert.match(attachmentNoticeText("near-budget", THRESHOLD), /close to that/);
});

test("only blob and attachment-route URLs may feed a link or image", () => {
	assert.equal(safeAttachmentUrl("blob:https://mail.example.com/abc"), "blob:https://mail.example.com/abc");
	assert.equal(safeAttachmentUrl("/api/messages/d/attachments/a?preview=1"), "/api/messages/d/attachments/a?preview=1");
	assert.equal(safeAttachmentUrl("javascript:alert(1)"), "");
	assert.equal(safeAttachmentUrl("https://evil.test/x.png"), "");
	assert.equal(safeAttachmentUrl(null), "");
});
