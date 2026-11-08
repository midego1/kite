import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-sender-auth-warning-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/messages/sender-auth-warning-utils.ts")],
	outfile: join(bundleDirectory, "sender-auth-warning-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { deriveSenderAuthWarning } = await import(
	pathToFileURL(join(bundleDirectory, "sender-auth-warning-utils.mjs")).href
);

function signals(...entries) {
	return JSON.stringify(entries);
}

test("a message that predates spam analysis, or never had signals, derives no warning", () => {
	assert.equal(deriveSenderAuthWarning(null, null), null);
	assert.equal(deriveSenderAuthWarning(undefined, null), null);
	assert.equal(deriveSenderAuthWarning("not json", null), null);
	assert.equal(deriveSenderAuthWarning(signals(), null), null);
});

test("a known contact whose mail passed cleanly gets no warning", () => {
	const clean = signals(
		{ id: "manual_contact", score: -8, reason: "Sender is in your manually saved contacts" },
		{ id: "dmarc_passed", score: -8, reason: "DMARC passed" },
		{ id: "dkim_passed", score: -4, reason: "DKIM passed", metadata: { aligned: true } },
	);
	assert.equal(deriveSenderAuthWarning(clean, null), null);
});

test("a message that predates spam analysis still gets a warning when its display name is spoofed", () => {
	const warning = deriveSenderAuthWarning(null, "maya@example.com");
	assert.deepEqual(warning.concerns, ["display_name_spoof"]);
	assert.equal(warning.spoofedContact, "maya@example.com");
});

test("a failed SPF, DKIM or DMARC check is surfaced, most serious first", () => {
	const failed = signals(
		{ id: "spf_failed", score: 6, reason: "SPF authentication failed" },
		{ id: "dkim_failed", score: 8, reason: "DKIM authentication failed" },
		{ id: "dmarc_failed", score: 18, reason: "DMARC authentication failed" },
	);
	const warning = deriveSenderAuthWarning(failed, null);
	assert.deepEqual(warning.concerns, ["dmarc_failed", "spf_failed", "dkim_failed"]);
	assert.equal(warning.spoofedContact, null);
});

test("a DKIM pass that is not aligned to the From domain is flagged; an aligned one is not", () => {
	const unaligned = signals({ id: "dkim_passed", score: -4, reason: "DKIM passed", metadata: { aligned: false } });
	assert.deepEqual(deriveSenderAuthWarning(unaligned, null).concerns, ["dkim_unaligned"]);
	const aligned = signals({ id: "dkim_passed", score: -4, reason: "DKIM passed", metadata: { aligned: true } });
	assert.equal(deriveSenderAuthWarning(aligned, null), null);
});

test("a cross-domain Reply-To is flagged on its own", () => {
	const mismatch = signals({ id: "reply_to_mismatch", score: 5, reason: "Reply-To domain differs" });
	assert.deepEqual(deriveSenderAuthWarning(mismatch, null).concerns, ["reply_to_mismatch"]);
});

test("a spoofed display name is flagged even over an otherwise clean message, and carries the contact", () => {
	const warning = deriveSenderAuthWarning(
		signals({ id: "dmarc_passed", score: -8, reason: "DMARC passed" }),
		"maya@example.com",
	);
	assert.deepEqual(warning.concerns, ["display_name_spoof"]);
	assert.equal(warning.spoofedContact, "maya@example.com");
});

test("every concern combines into one warning, ordered the same way regardless of signal order", () => {
	const forward = deriveSenderAuthWarning(
		signals(
			{ id: "reply_to_mismatch", score: 5, reason: "Reply-To domain differs" },
			{ id: "spf_failed", score: 6, reason: "SPF authentication failed" },
			{ id: "dmarc_failed", score: 18, reason: "DMARC authentication failed" },
		),
		"maya@example.com",
	);
	const backward = deriveSenderAuthWarning(
		signals(
			{ id: "dmarc_failed", score: 18, reason: "DMARC authentication failed" },
			{ id: "spf_failed", score: 6, reason: "SPF authentication failed" },
			{ id: "reply_to_mismatch", score: 5, reason: "Reply-To domain differs" },
		),
		"maya@example.com",
	);
	assert.deepEqual(forward.concerns, ["dmarc_failed", "display_name_spoof", "spf_failed", "reply_to_mismatch"]);
	assert.deepEqual(forward.concerns, backward.concerns);
});
