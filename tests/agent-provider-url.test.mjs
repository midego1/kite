import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-provider-url-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src"), "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
		external: ["react", "react-dom", "next", "next/*", "better-sqlite3"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const utils = await bundle("src/lib/agent/provider-url-utils.ts", "provider-url-utils.mjs");
const provider = await bundle("src/lib/agent/provider.ts", "provider.mjs");

const LOOPBACK = ["http://127.0.0.1:3301", "http://localhost:3301/", "http://127.0.0.1:4100/v1"];

function withNodeEnv(value, run) {
	const previous = process.env.NODE_ENV;
	if (value === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previous;
	}
}

test("the loopback flag needs exactly '1' outside production", () => {
	assert.equal(utils.isAgentLoopbackAllowed("1", undefined), true);
	assert.equal(utils.isAgentLoopbackAllowed("1", "development"), true);
	assert.equal(utils.isAgentLoopbackAllowed("1", "test"), true);
	for (const flag of [undefined, "", "0", "true", "yes"])
		assert.equal(utils.isAgentLoopbackAllowed(flag, "development"), false, String(flag));
	assert.equal(utils.isAgentLoopbackAllowed("1", "production"), false);
});

test("resolveAgentBaseUrl accepts http loopback only with the flag outside production", () => {
	const flagged = { AI_ALLOW_INSECURE_LOOPBACK: "1" };
	withNodeEnv("development", () => {
		assert.equal(provider.resolveAgentBaseUrl("custom", "http://127.0.0.1:3301/", flagged), "http://127.0.0.1:3301");
		assert.equal(provider.resolveAgentBaseUrl("custom", "http://localhost:3301", flagged), "http://localhost:3301");
		for (const url of LOOPBACK) {
			assert.throws(() => provider.resolveAgentBaseUrl("custom", url), /HTTPS/, url);
			assert.throws(() => provider.resolveAgentBaseUrl("custom", url, {}), /HTTPS/, url);
			assert.throws(() => provider.resolveAgentBaseUrl("custom", url, { AI_ALLOW_INSECURE_LOOPBACK: "true" }), /HTTPS/);
		}
	});
	withNodeEnv("production", () => {
		for (const url of LOOPBACK) assert.throws(() => provider.resolveAgentBaseUrl("custom", url, flagged), /HTTPS/, url);
	});
});

test("the flag never opens plain http to other hosts or relaxes the other URL rules", () => {
	const flagged = { AI_ALLOW_INSECURE_LOOPBACK: "1" };
	withNodeEnv("development", () => {
		for (const url of [
			"http://example.com",
			"http://10.0.0.5:3301",
			"http://127.0.0.2:3301",
			"http://[::1]:3301",
			"http://user:pass@127.0.0.1:3301",
			"http://127.0.0.1:3301/?debug=1",
			"http://127.0.0.1:3301/#x",
			"ftp://127.0.0.1",
		])
			assert.throws(() => provider.resolveAgentBaseUrl("custom", url, flagged), /HTTPS/, url);
		assert.equal(
			provider.resolveAgentBaseUrl("custom", "https://llm.example.com/v1/", flagged),
			"https://llm.example.com/v1",
		);
		assert.equal(
			provider.resolveAgentBaseUrl("openrouter", "http://127.0.0.1", flagged),
			"https://openrouter.ai/api/v1",
		);
	});
});
