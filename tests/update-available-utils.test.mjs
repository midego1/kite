import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-update-available-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/update-available-utils.ts")],
	outfile: join(bundleDirectory, "update.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const UPDATE_CHECK_MIN_GAP_MS = 60_000;
const {
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_TOAST_MESSAGE,
	UPDATE_ROW_SUBJECT,
	chooseUpdateSurface,
	compareDeploymentVersion,
	parseDeploymentVersion,
	shouldCheckForUpdate,
	updateRowPreview,
} = await import(pathToFileURL(join(bundleDirectory, "update.mjs")).href);

test("checks every five minutes and at most once a minute on focus", () => {
	assert.equal(UPDATE_CHECK_INTERVAL_MS, 300_000);
	const now = 1_000_000;
	const visible = { now, visible: true, inFlight: false };
	assert.equal(shouldCheckForUpdate({ ...visible, lastCheckAt: now - UPDATE_CHECK_MIN_GAP_MS + 1 }), false);
	assert.equal(shouldCheckForUpdate({ ...visible, lastCheckAt: now - UPDATE_CHECK_MIN_GAP_MS }), true);
	assert.equal(UPDATE_TOAST_MESSAGE, "Kite was updated. Reload to get the latest version.");
});

test("parseDeploymentVersion reads only a string version", () => {
	assert.equal(parseDeploymentVersion({ version: "abc-123" }), "abc-123");
	assert.equal(parseDeploymentVersion({ version: "  abc  " }), "abc");
	assert.equal(parseDeploymentVersion({ version: "" }), "");
	assert.equal(parseDeploymentVersion({ version: 7 }), "");
	assert.equal(parseDeploymentVersion({}), "");
	assert.equal(parseDeploymentVersion(null), "");
	assert.equal(parseDeploymentVersion("abc"), "");
});

test("shouldCheckForUpdate checks a visible tab once per gap", () => {
	const base = { now: 1_000_000, visible: true, inFlight: false };
	assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: null }), true);
	assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - 1_000 }), false);
	assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - UPDATE_CHECK_MIN_GAP_MS + 1 }), false);
	assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - UPDATE_CHECK_MIN_GAP_MS }), true);
	assert.equal(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - UPDATE_CHECK_INTERVAL_MS }), true);
});

test("shouldCheckForUpdate never checks a hidden tab or during a request", () => {
	const now = 1_000_000;
	assert.equal(shouldCheckForUpdate({ now, lastCheckAt: null, visible: false, inFlight: false }), false);
	assert.equal(shouldCheckForUpdate({ now, lastCheckAt: null, visible: true, inFlight: true }), false);
	assert.equal(shouldCheckForUpdate({ now, lastCheckAt: 0, visible: false, inFlight: false }), false);
});

test("compareDeploymentVersion records the first version and reports a different one", () => {
	assert.deepEqual(compareDeploymentVersion("", "v1"), { known: "v1", changed: false });
	assert.deepEqual(compareDeploymentVersion("v1", "v1"), { known: "v1", changed: false });
	assert.deepEqual(compareDeploymentVersion("v1", "v2"), { known: "v1", changed: true });
});

test("compareDeploymentVersion never reports an unknown version as an update", () => {
	assert.deepEqual(compareDeploymentVersion("", ""), { known: "", changed: false });
	assert.deepEqual(compareDeploymentVersion("v1", ""), { known: "v1", changed: false });
});

test("the notice goes to a message list when one is on screen and to a toast elsewhere", () => {
	const base = { available: true, dismissed: false };
	assert.equal(chooseUpdateSurface({ ...base, lists: 0 }), "toast");
	assert.equal(chooseUpdateSurface({ ...base, lists: 1 }), "row");
	assert.equal(chooseUpdateSurface({ ...base, lists: 2 }), "row");
	assert.equal(chooseUpdateSurface({ available: false, dismissed: false, lists: 1 }), "none");
	assert.equal(chooseUpdateSurface({ available: false, dismissed: false, lists: 0 }), "none");
});

test("a dismissed notice shows nowhere, whatever the page", () => {
	assert.equal(chooseUpdateSurface({ available: true, dismissed: true, lists: 0 }), "none");
	assert.equal(chooseUpdateSurface({ available: true, dismissed: true, lists: 1 }), "none");
});

test("the row names the version that is waiting, shortened to something readable", () => {
	const preview = "Reload to get the latest version";
	assert.equal(UPDATE_ROW_SUBJECT, "Kite was updated");
	assert.equal(updateRowPreview("3f2a9c1e-7b4d-4e6a-9c1d-0123456789ab"), `${preview} · 3f2a9c1e`);
	assert.equal(updateRowPreview("deploy-2"), `${preview} · deploy-2`);
	assert.equal(updateRowPreview("  deploy-2  "), `${preview} · deploy-2`);
	assert.equal(updateRowPreview("2026.10.30 2026-10-30T10:00:00Z"), `${preview} · 2026.10.30`);
	assert.equal(updateRowPreview("a-very-long-build-identifier-without-spaces"), `${preview} · a-very-long-buil`);
	assert.equal(updateRowPreview(""), preview);
});
