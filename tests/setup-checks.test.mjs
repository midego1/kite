import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-setup-checks-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/setup/configuration-utils.ts")],
	outfile: join(outDir, "checks.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const checks = await import(pathToFileURL(join(outDir, "checks.mjs")).href);

const origin = "https://kite.example.workers.dev";

test("a missing encryption key is a warning that never blocks setup", () => {
	const check = checks.checkEncryptionKey({ env: {}, production: true });
	assert.equal(check.configured, false);
	assert.equal(check.severity, "recommended");
	assert.match(check.message, /APP_ENCRYPTION_KEY/);
	assert.match(check.message, /openssl rand -hex 32/);
	assert.equal(checks.hasBlockingFailure([check]), false);
});

test("the example or a short encryption key blocks first-run setup in production only", () => {
	for (const value of ["a-long-random-string", "short"]) {
		const production = checks.checkEncryptionKey({ env: { APP_ENCRYPTION_KEY: value }, production: true });
		assert.equal(production.severity, "required", value);
		assert.equal(checks.hasBlockingFailure([production]), true);
		const development = checks.checkEncryptionKey({ env: { APP_ENCRYPTION_KEY: value }, production: false });
		assert.equal(development.severity, "recommended", value);
	}
});

test("a long random encryption key passes", () => {
	const check = checks.checkEncryptionKey({ env: { APP_ENCRYPTION_KEY: "f".repeat(64) }, production: true });
	assert.equal(check.configured, true);
});

test("a missing APP_URL suggests the address the page was opened at", () => {
	const check = checks.checkAppUrl({ env: {}, origin });
	assert.equal(check.configured, false);
	assert.equal(check.severity, "recommended");
	assert.match(check.message, new RegExp(`APP_URL=${origin.replaceAll(".", "\\.")}`));
});

test("APP_URL must be a valid https address that matches the page", () => {
	assert.match(checks.checkAppUrl({ env: { APP_URL: "not a url" }, origin }).message, /not a valid address/);
	assert.match(checks.checkAppUrl({ env: { APP_URL: "http://mail.example.com" }, origin }).message, /https:\/\//);
	assert.match(
		checks.checkAppUrl({ env: { APP_URL: "https://other.example.com" }, origin }).message,
		/not the address/,
	);
	assert.equal(checks.checkAppUrl({ env: { APP_URL: origin }, origin }).configured, true);
	assert.equal(checks.checkAppUrl({ env: { APP_URL: `${origin}/` }, origin }).configured, true);
});

test("APP_URL on a self-hosted install may be plain http on loopback", () => {
	assert.equal(checks.checkAppUrl({ env: { APP_URL: "http://localhost:3000" } }).configured, true);
});

test("a Worker on workers.dev that is not called kite is flagged", () => {
	const wrong = checks.checkWorkerName({ origin: "https://my-mail.example.workers.dev" });
	assert.equal(wrong.configured, false);
	assert.match(wrong.message, /named "my-mail"/);
	assert.equal(checks.checkWorkerName({ origin }).configured, true);
	assert.equal(checks.checkWorkerName({ origin: "https://feature-kite.example.workers.dev" }).configured, true);
});

test("the Worker name is not judged on a custom domain", () => {
	assert.equal(checks.checkWorkerName({ origin: "https://mail.example.com" }), null);
	assert.equal(checks.checkWorkerName({}), null);
});

test("a token Cloudflare rejects blocks setup with the permission list", () => {
	const check = checks.checkCloudflareTokenResult({ kind: "rejected", detail: "Invalid access token" });
	assert.equal(check.severity, "required");
	assert.match(check.message, /Email Routing Rules: Edit/);
	assert.match(check.message, /Invalid access token/);
});

test("a token that sees no zones, or a failed lookup, only warns", () => {
	assert.equal(checks.checkCloudflareTokenResult({ kind: "ok" }).configured, true);
	for (const outcome of [{ kind: "no_zones" }, { kind: "unreachable", detail: "timeout" }]) {
		const check = checks.checkCloudflareTokenResult(outcome);
		assert.equal(check.configured, false);
		assert.equal(check.severity, "recommended");
	}
});

test("only unmet required checks block", () => {
	assert.equal(checks.hasBlockingFailure([{ key: "a", configured: false, message: "" }]), true);
	assert.equal(checks.hasBlockingFailure([{ key: "a", configured: false, severity: "required", message: "" }]), true);
	assert.equal(checks.hasBlockingFailure([{ key: "a", configured: true, message: "" }]), false);
});
