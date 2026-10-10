import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-app-passwords-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/components/settings/email-clients-settings-utils.ts";
			export { API_KEY_MAX_MAILBOXES } from "./src/lib/api/scopes.ts";
		`,
		resolveDir: root,
		sourcefile: "app-passwords-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { API_KEY_MAX_MAILBOXES, apiErrorMessage, defaultAppPasswordMailboxIds, toggleMailboxId } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const mailboxes = (count) => Array.from({ length: count }, (_, index) => ({ id: `mbx_${index}` }));

test("an app password starts with every mailbox while they fit in one key", () => {
	assert.deepEqual(defaultAppPasswordMailboxIds(mailboxes(3), "mbx_1"), ["mbx_0", "mbx_1", "mbx_2"]);
	assert.equal(defaultAppPasswordMailboxIds(mailboxes(API_KEY_MAX_MAILBOXES), null).length, API_KEY_MAX_MAILBOXES);
	assert.deepEqual(defaultAppPasswordMailboxIds([], "mbx_1"), []);
});

test("past the per-key limit only the current mailbox is preselected", () => {
	const many = mailboxes(API_KEY_MAX_MAILBOXES + 1);
	assert.deepEqual(defaultAppPasswordMailboxIds(many, "mbx_7"), ["mbx_7"]);
	assert.deepEqual(defaultAppPasswordMailboxIds(many, "gone"), ["mbx_0"]);
	assert.deepEqual(defaultAppPasswordMailboxIds(many, undefined), ["mbx_0"]);
});

test("toggling a mailbox adds it once and removes it", () => {
	assert.deepEqual(toggleMailboxId(["a"], "b", true), ["a", "b"]);
	assert.deepEqual(toggleMailboxId(["a", "b"], "b", true), ["a", "b"]);
	assert.deepEqual(toggleMailboxId(["a", "b"], "a", false), ["b"]);
	assert.deepEqual(toggleMailboxId([], "a", false), []);
});

test("API errors show the server's message, including zod validation output", () => {
	assert.equal(
		apiErrorMessage("Choose a mailbox for mail permissions", "fallback"),
		"Choose a mailbox for mail permissions",
	);
	assert.equal(
		apiErrorMessage(
			{ formErrors: [], fieldErrors: { mailboxIds: ["Invalid input: expected array, received undefined"] } },
			"fallback",
		),
		"mailboxIds: Invalid input: expected array, received undefined",
	);
	assert.equal(
		apiErrorMessage({ formErrors: ["Bad body"], fieldErrors: { name: ["Too short", "Required"] } }, "fallback"),
		"Bad body; name: Too short; name: Required",
	);
	for (const unusable of [undefined, null, "", "  ", 42, {}, { formErrors: [1] }, { fieldErrors: { name: "x" } }])
		assert.equal(apiErrorMessage(unusable, "fallback"), "fallback");
});
