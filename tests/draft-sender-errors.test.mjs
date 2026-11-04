import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-draft-sender-errors-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { getDraftSender } from "./src/app/api/drafts/utils.ts";`,
		resolveDir: root,
		sourcefile: "draft-sender-errors-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { getDraftSender } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a refusal written for the sender reaches the draft save as it is", async () => {
	assert.deepEqual(await getDraftSender({}, "user", { from: "a@example.com" }), { error: "Mailbox is required" });
});

test("any other failure while checking the sender shows a generic message, never its text", async () => {
	const env = {
		get DB() {
			throw new Error("SQLITE_ERROR: near select * from mailboxes where id = 'mbx_secret'");
		},
	};
	const result = await getDraftSender(env, "user", { from: "a@example.com", mailboxId: "mbx_secret" });
	assert.deepEqual(result, { error: "Could not check the sender; try again" });
});
