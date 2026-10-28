import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { root } from "./support/modules-bundle.mjs";

const outDir = makeBundleDirectory("kite-message-bodies-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));
// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: { utils: fileURLToPath(import.meta.resolve("../src/lib/email/bodies-utils.ts")) },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const {
	BODY_OFFLOAD_BYTES,
	derivedTextBody,
	exceedsBodyOffloadBytes,
	htmlBodyObjectKey,
	isHtmlBodyObjectKey,
	planHtmlBodyOffload,
	withoutDerivedText,
} = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("the threshold is 16 KB of UTF-8, counted in bytes rather than characters", () => {
	assert.equal(BODY_OFFLOAD_BYTES, 16 * 1024);
	assert.equal(exceedsBodyOffloadBytes(null), false);
	assert.equal(exceedsBodyOffloadBytes(""), false);
	assert.equal(exceedsBodyOffloadBytes("a".repeat(BODY_OFFLOAD_BYTES)), false);
	assert.equal(exceedsBodyOffloadBytes("a".repeat(BODY_OFFLOAD_BYTES + 1)), true);
	// 6,000 characters of three bytes each: under the limit in characters, over it in bytes.
	assert.equal(exceedsBodyOffloadBytes("€".repeat(6_000)), true);
	assert.equal(exceedsBodyOffloadBytes("€".repeat(5_000)), false);
	// Short enough that even three bytes a character stays under: no encoding needed.
	assert.equal(exceedsBodyOffloadBytes("€".repeat(Math.floor(BODY_OFFLOAD_BYTES / 3))), false);
	assert.equal(exceedsBodyOffloadBytes("abcd", 3), true);
	assert.equal(exceedsBodyOffloadBytes("€", 2), true);
});

test("a message has exactly one body key, and no other key counts as one", () => {
	assert.equal(htmlBodyObjectKey("msg_1"), "bodies/msg_1.html");
	assert.equal(isHtmlBodyObjectKey("msg_1", "bodies/msg_1.html"), true);
	for (const key of [null, undefined, "", "bodies/msg_2.html", "attachments/msg_1/a", "backups/x.json", "bodies/msg_1"])
		assert.equal(isHtmlBodyObjectKey("msg_1", key), false, String(key));
});

test("only HTML over the threshold is offloaded, and the row keeps a text body for search", () => {
	const big = `<p>${"Quarterly numbers &amp; notes. ".repeat(700)}</p>`;
	assert.equal(planHtmlBodyOffload("m", { text: "Hi", html: "<p>Hi</p>" }), null);
	assert.equal(planHtmlBodyOffload("m", { text: "Hi", html: null }), null);
	assert.deepEqual(planHtmlBodyOffload("m", { text: "The text part", html: big }), {
		key: "bodies/m.html",
		html: big,
		bodySize: "The text part".length + big.length,
		textBody: "The text part",
	});
	// Bytes, as Email/get counts them: a derived text body is not counted, it is not a part of the message.
	assert.equal(planHtmlBodyOffload("m", { text: "Café", html: "<p>€</p>" }, 4).bodySize, 5 + 10);
	assert.equal(planHtmlBodyOffload("m", { text: null, html: "<p>€</p>" }, 4).bodySize, 10);
	const htmlOnly = planHtmlBodyOffload("m", { text: null, html: big });
	assert.equal(htmlOnly.textBody, derivedTextBody(big));
	assert.match(htmlOnly.textBody, /^ Quarterly numbers & notes\./);
	assert.equal(planHtmlBodyOffload("m", { text: "", html: "<b>long</b>" }, 4).textBody, " long ");
});

test("reading back resets only a text body the offload derived from that HTML", () => {
	const html = "<p>Hello <b>there</b></p>";
	const derived = derivedTextBody(html);
	assert.deepEqual(withoutDerivedText({ id: "m", textBody: derived }, html), { id: "m", textBody: null });
	const ownText = { id: "m", textBody: "Hello there, from the text part" };
	assert.equal(withoutDerivedText(ownText, html), ownText);
	const empty = { id: "m", textBody: "" };
	assert.equal(withoutDerivedText(empty, "<img src=x>"), empty);
	const none = { id: "m" };
	assert.equal(withoutDerivedText(none, html), none);
});
