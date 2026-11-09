import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-assistant-email-reasons-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { reasons: join(root, "src/lib/agent/email/request-reasons-utils.ts") },
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
const { requestReasonText } = await import(pathToFileURL(join(outDir, "reasons.mjs")).href);

test("every known reason code reads as a plain sentence", () => {
	for (const code of [
		"user_unavailable",
		"assistant_disabled",
		"mailbox_unavailable",
		"raw_missing",
		"mime_limit",
		"mailbox_ai_off",
		"external_provider_not_allowed",
		"not_configured",
		"spend_cap",
		"model_error",
		"no_sending_provider",
	]) {
		const text = requestReasonText(code);
		assert.equal(typeof text, "string");
		assert.ok(text.length > 0);
		assert.doesNotMatch(text, /_/, `${code} leaked its internal spelling`);
	}
});

test("a :send_failed suffix adds a note without losing the base reason's text", () => {
	const base = requestReasonText("spend_cap");
	const suffixed = requestReasonText("spend_cap:send_failed");
	assert.ok(suffixed.startsWith(base));
	assert.match(suffixed, /reply could not be sent/);
});

test("an unknown code still reads as something, never the raw string", () => {
	assert.equal(requestReasonText("something_new_nobody_classified"), "Kite could not finish this request.");
});

test("no reason is null", () => {
	assert.equal(requestReasonText(null), null);
});

test("a plain send_failed reads as its own sentence, not the generic fallback", () => {
	const text = requestReasonText("send_failed");
	assert.notEqual(text, "Kite could not finish this request.");
	assert.match(text, /reply could not be sent/);
});

test("a :no_sending_provider suffix says the reply could not be sent, like :send_failed does", () => {
	const base = requestReasonText("spend_cap");
	const suffixed = requestReasonText("spend_cap:no_sending_provider");
	assert.ok(suffixed.startsWith(base));
	assert.match(suffixed, /reply could not be sent/);
	assert.match(requestReasonText("model_error:no_sending_provider"), /reply could not be sent/);
});
