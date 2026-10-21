import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-domains-ui-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/app/(admin)/domains/utils.ts")],
	outfile: join(directory, "utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { getSendingStatusLabel } = await import(pathToFileURL(join(directory, "utils.mjs")).href);

test("sending labels distinguish Cloudflare subdomains from manual configuration", () => {
	assert.equal(
		getSendingStatusLabel(undefined, false, false, false),
		"Sending has not been configured for this domain",
	);
	assert.equal(
		getSendingStatusLabel("mail.example.test", true, false, true),
		"Sending for mail.example.test is enabled",
	);
	assert.equal(
		getSendingStatusLabel("mail.example.test", false, false, false),
		"Sending for mail.example.test is disabled",
	);
	assert.equal(getSendingStatusLabel(undefined, false, true, true), "Email sending is configured");
	assert.equal(getSendingStatusLabel(undefined, false, true, false), "Email sending is not configured");
});
