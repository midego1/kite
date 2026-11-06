import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migration-label-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/migration-label-utils.ts")],
	outfile: join(bundleDirectory, "label.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { migrationLabel } = await import(pathToFileURL(join(bundleDirectory, "label.mjs")).href);

test("a migration file name reads as words, with acronyms in capitals", () => {
	assert.equal(migrationLabel("0092_add_mailbox_ai_disabled_at.sql"), "Add mailbox AI disabled at");
	assert.equal(migrationLabel("0088_attachment_raw_storage.sql"), "Attachment raw storage");
	assert.equal(migrationLabel("0040_add_jmap_mailbox_revisions.sql"), "Add JMAP mailbox revisions");
});

test("a name that is not a numbered migration is shown as it is", () => {
	assert.equal(migrationLabel("custom.sql"), "custom.sql");
	assert.equal(migrationLabel("0001_.sql"), "0001_.sql");
});
