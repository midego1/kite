import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import * as undo from "../src/lib/email/undo-send-utils.ts";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-sending-preferences-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const validators = await bundle("src/lib/validators.ts", "validators.mjs");
const preview = await bundle("src/components/compose/send-preview-utils.ts", "preview.mjs");

test("a composer send without a schedule is held for the undo window", () => {
	const now = Date.parse("2026-10-06T10:00:00.000Z");
	assert.deepEqual(undo.resolveComposerSendTime(undefined, 10, now), {
		scheduledAt: "2026-10-06T10:00:10.000Z",
		undoUntil: "2026-10-06T10:00:10.000Z",
	});
});

test("an explicit schedule wins and is not undoable", () => {
	assert.deepEqual(undo.resolveComposerSendTime("2026-10-07T08:00:00.000Z", 10), {
		scheduledAt: "2026-10-07T08:00:00.000Z",
		undoUntil: null,
	});
});

test("undo off, or an unsupported stored value, sends at once", () => {
	assert.deepEqual(undo.resolveComposerSendTime(undefined, 0), { scheduledAt: undefined, undoUntil: null });
	assert.deepEqual(undo.resolveComposerSendTime(undefined, 7), { scheduledAt: undefined, undoUntil: null });
});

test("the settings schema accepts only listed undo windows and needs a field", () => {
	const schema = validators.updateSendingSettingsSchema;
	assert.equal(schema.parse({ undoSeconds: 30 }).undoSeconds, 30);
	assert.equal(schema.parse({ previewEnabled: true }).previewEnabled, true);
	assert.throws(() => schema.parse({ undoSeconds: 7 }));
	assert.throws(() => schema.parse({ undoSeconds: 3600 }));
	assert.throws(() => schema.parse({ previewEnabled: "yes" }));
	assert.throws(() => schema.parse({}));
});

test("the preview document wraps the message in a standalone page", () => {
	const document = preview.buildPreviewDocument("<p>Hello</p>");
	assert.match(document, /^<!doctype html>/);
	assert.match(document, /<body><p>Hello<\/p><\/body>/);
	assert.equal(preview.formatPreviewAttachments([]), null);
	assert.equal(preview.formatPreviewAttachments(["a.pdf", "b.png"]), "a.pdf, b.png");
});

test("migration adds both user columns off by default and the journal lists it", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id text primary key)");
	db.exec(readFileSync(join(root, "drizzle/migrations/0055_add_sending_preferences.sql"), "utf8"));
	db.exec("INSERT INTO users (id) VALUES ('u')");
	const row = db.prepare("SELECT send_preview_enabled AS preview, undo_send_seconds AS undo FROM users").get();
	assert.deepEqual({ ...row }, { preview: 0, undo: 0 });

	const journal = JSON.parse(readFileSync(join(root, "drizzle/migrations/meta/_journal.json"), "utf8"));
	const entry = journal.entries.find((item) => item.tag === "0055_add_sending_preferences");
	assert.equal(entry?.idx, journal.entries.indexOf(entry));
});
