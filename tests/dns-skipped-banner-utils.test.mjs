import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-dns-skipped-banner-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/components/dns-skipped-banner-utils.ts";
			export * from "./src/app/(auth)/register/mx-status-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "dns-skipped-entry.ts",
	},
	outfile: join(bundleDirectory, "banner.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { dnsSkippedBannerContent, mxCheckBlocksSubmit, parseSkippedDomains } = await import(
	pathToFileURL(join(bundleDirectory, "banner.mjs")).href
);

test("parseSkippedDomains keeps only domains flagged as skipped", () => {
	assert.deepEqual(
		parseSkippedDomains({
			domains: [
				{ id: "dom-1", hostname: "skip.example.test", dnsSkipped: true },
				{ id: "dom-2", hostname: "done.example.test", dnsSkipped: false },
				// Before the migration the flag is absent or false, never a reason to warn.
				{ id: "dom-3", hostname: "old.example.test" },
				{ id: 4, hostname: "bad.example.test", dnsSkipped: true },
				{ id: "dom-5", dnsSkipped: true },
				null,
				"dom-6",
			],
		}),
		[{ id: "dom-1", hostname: "skip.example.test" }],
	);
});

test("parseSkippedDomains reads anything unexpected as no domain", () => {
	for (const value of [undefined, null, "domains", 3, {}, { domains: "dom-1" }, { domains: null }]) {
		assert.deepEqual(parseSkippedDomains(value), []);
	}
});

test("dnsSkippedBannerContent names one domain and counts several", () => {
	assert.deepEqual(dnsSkippedBannerContent([{ id: "dom-1", hostname: "skip.example.test" }]), {
		title: "DNS setup was skipped for skip.example.test",
		body: "Mail will not arrive until its DNS records are set.",
	});
	assert.deepEqual(
		dnsSkippedBannerContent([
			{ id: "dom-1", hostname: "a.example.test" },
			{ id: "dom-2", hostname: "b.example.test" },
		]),
		{
			title: "DNS setup was skipped for 2 domains",
			body: "Mail will not arrive until their DNS records are set.",
		},
	);
});

test("mxCheckBlocksSubmit waits for the MX check unless DNS setup is skipped", () => {
	const state = { skipDns: false, checking: false, recordsExist: false, replaceRecords: false };
	assert.equal(mxCheckBlocksSubmit(state), false);
	assert.equal(mxCheckBlocksSubmit({ ...state, checking: true }), true);
	assert.equal(mxCheckBlocksSubmit({ ...state, recordsExist: null }), true);
	assert.equal(mxCheckBlocksSubmit({ ...state, recordsExist: true }), true);
	assert.equal(mxCheckBlocksSubmit({ ...state, recordsExist: true, replaceRecords: true }), false);
	assert.equal(mxCheckBlocksSubmit({ ...state, skipDns: true, checking: true, recordsExist: null }), false);
});
