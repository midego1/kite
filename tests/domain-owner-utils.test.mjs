import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-domain-owner-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/domains/owner-utils.ts")],
	outfile: join(bundleDirectory, "owner-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { domainOwnerId } = await import(pathToFileURL(join(bundleDirectory, "owner-utils.mjs")).href);

test("a mailbox-managing account works on its creator's domains; everyone else on their own", () => {
	assert.equal(domainOwnerId({ id: "u1", canManageMailboxes: true, createdByUserId: "admin" }), "admin");
	assert.equal(domainOwnerId({ id: "u1", canManageMailboxes: true, createdByUserId: null }), "u1");
	assert.equal(domainOwnerId({ id: "u1", canManageMailboxes: false, createdByUserId: "admin" }), "u1");
	assert.equal(domainOwnerId({ id: "admin", canManageMailboxes: false, createdByUserId: null }), "admin");
});
