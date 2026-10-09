import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-rename-compat-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { applyMailboxSignatureHtml, splitQuotedHtml, wrapQuotedHtml } from "./src/components/compose/rich-text-utils.ts";
			export { KITE_FORWARDED_HEADER, wasForwardedByKite } from "./src/lib/email/account-forwarding.ts";
			export { readRelayHeader } from "./src/lib/email/intake-signature.ts";
		`,
		resolveDir: root,
		sourcefile: "kite-rename-compat-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const helpers = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("new quotes use the Kite marker and fold in the reader", () => {
	const html = `<p>Reply</p>${helpers.wrapQuotedHtml("<p>Original</p>")}`;
	assert.match(html, /data-kite-quote="1"/);
	assert.deepEqual(helpers.splitQuotedHtml(html), { body: "<p>Reply</p>", quoted: "<p>Original</p>" });
});

test("quotes saved before the rename still fold", () => {
	const html = `<p>Reply</p><div class="mailflare-quote" data-mailflare-quote="1"><p>Original</p></div>`;
	assert.deepEqual(helpers.splitQuotedHtml(html), { body: "<p>Reply</p>", quoted: "<p>Original</p>" });
});

test("a signature saved before the rename is swapped instead of duplicated", () => {
	const draft = `<p>Hi</p><div data-mailflare-signature="1"><br><br>Old</div>`;
	assert.equal(
		helpers.applyMailboxSignatureHtml(draft, "Old", "New"),
		`<p>Hi</p><div data-kite-signature="1"><br><br>New</div>`,
	);
});

test("account forwarding recognises both loop-guard headers", () => {
	assert.equal(helpers.KITE_FORWARDED_HEADER, "X-Kite-Forwarded");
	const headers = (values) => (name) => values[name];
	assert.equal(helpers.wasForwardedByKite(headers({ "x-kite-forwarded": "1" })), true);
	assert.equal(helpers.wasForwardedByKite(headers({ "X-Mailflare-Forwarded": "1" })), true);
	assert.equal(helpers.wasForwardedByKite(headers({ "x-mailflare-forwarded": "1" })), true);
	assert.equal(helpers.wasForwardedByKite(headers({})), false);
});

test("the inbound webhook reads the new relay headers and the pre-rename ones", () => {
	const current = new Headers({ "X-Kite-From": "a@example.com", "X-Mailflare-From": "old@example.com" });
	assert.equal(helpers.readRelayHeader(current, "from"), "a@example.com");
	const legacy = new Headers({ "X-Mailflare-Signature": "abc" });
	assert.equal(helpers.readRelayHeader(legacy, "signature"), "abc");
	assert.equal(helpers.readRelayHeader(new Headers(), "to"), null);
});
