import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-assistant-email-daily-limit-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		limit: join(root, "src/lib/agent/email/daily-limit-utils.ts"),
		validators: join(root, "src/lib/validators.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	packages: "external",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const { parseDailyLimit } = await import(pathToFileURL(join(outDir, "limit.mjs")).href);
const { updateAssistantSettingsSchema } = await import(pathToFileURL(join(outDir, "validators.mjs")).href);

test("the client accepts exactly the limits the server accepts", () => {
	for (const text of ["0", "1", "50", "100", "101", "-3", "2.5", "", "  ", "abc", " 7 "]) {
		const client = parseDailyLimit(text).ok;
		const server = updateAssistantSettingsSchema.safeParse({
			emailAssistant: { dailyLimit: Number(text.trim() === "" ? Number.NaN : text) },
		}).success;
		assert.equal(client, server, `"${text}" is judged the same on both sides`);
	}
});

test("a rejected limit comes with a plain message naming the bounds", () => {
	const result = parseDailyLimit("500");
	assert.equal(result.ok, false);
	assert.match(result.error, /1 to 100/);
	assert.deepEqual(parseDailyLimit(" 7 "), { ok: true, value: 7 });
});
