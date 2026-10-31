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
	UPDATE_ROW_ANNOUNCEMENT,
	UPDATE_ROW_PREVIEW,
	UPDATE_ROW_SUBJECT,
	chooseUpdateSurface,
	compareDeploymentVersion,
	isUpdateReaderOpen,
	parseDeploymentVersion,
	parseUpdateDetails,
	shouldCheckForUpdate,
	updatePreview,
	updateSubject,
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

test("choosing Reload takes the notice off both surfaces while the flight plays", () => {
	assert.equal(chooseUpdateSurface({ available: true, dismissed: false, lists: 1, reloading: true }), "none");
	assert.equal(chooseUpdateSurface({ available: true, dismissed: false, lists: 0, reloading: true }), "none");
	assert.equal(chooseUpdateSurface({ available: true, dismissed: false, lists: 1, reloading: false }), "row");
});

test("a dismissed notice shows nowhere, whatever the page", () => {
	assert.equal(chooseUpdateSurface({ available: true, dismissed: true, lists: 0 }), "none");
	assert.equal(chooseUpdateSurface({ available: true, dismissed: true, lists: 1 }), "none");
});

test("the row's text is fixed and names no deployment id", () => {
	assert.equal(UPDATE_ROW_SUBJECT, "Kite was updated");
	assert.equal(UPDATE_ROW_PREVIEW, "Reload to get the latest version");
	// The live region says something else than the toast, so the two never read as one message twice.
	assert.notEqual(UPDATE_ROW_ANNOUNCEMENT, UPDATE_TOAST_MESSAGE);
});

const NOTES = [
	{
		name: "2026.11.01.0",
		date: "2026-11-01",
		sections: [{ title: "Added", items: ["**Snooze** in [Settings](/settings/inbox) lists `later`."] }],
	},
];

test("parseUpdateDetails keeps a newer calendar release and well-formed notes", () => {
	assert.deepEqual(parseUpdateDetails({ version: "x", release: "2026.11.01.0", notes: NOTES }, "2026.10.31.3"), {
		release: "2026.11.01.0",
		notes: NOTES,
	});
	// The same release, a development build or a missing field name no release.
	assert.equal(parseUpdateDetails({ release: "2026.10.31.3" }, "2026.10.31.3").release, null);
	assert.equal(parseUpdateDetails({ release: "development" }, "2026.10.31.3").release, null);
	assert.deepEqual(parseUpdateDetails({ version: "x" }, "2026.10.31.3"), { release: null, notes: [] });
	assert.deepEqual(parseUpdateDetails(null, "2026.10.31.3"), { release: null, notes: [] });
});

test("parseUpdateDetails drops malformed notes instead of showing them", () => {
	const notes = [
		{ name: "", sections: [] },
		{
			name: "A",
			sections: [
				{ title: "Fixed", items: [7, "", "One fix"] },
				{ title: "Empty", items: [] },
			],
		},
		"text",
		{ name: "B", sections: "nope" },
	];
	assert.deepEqual(parseUpdateDetails({ notes }, "").notes, [
		{ name: "A", date: null, sections: [{ title: "Fixed", items: ["One fix"] }] },
	]);
	const long = { name: "C", sections: [{ title: "Added", items: ["x".repeat(5_000)] }] };
	assert.equal(parseUpdateDetails({ notes: [long] }, "").notes[0].sections[0].items[0].length, 2_000);
});

test("the subject names a known release and the preview adds the first note as plain text", () => {
	assert.equal(updateSubject({ release: null, notes: [] }), "Kite was updated");
	assert.equal(updateSubject({ release: "2026.11.01.0", notes: [] }), "Kite 2026.11.01.0 is ready");
	assert.equal(updatePreview({ release: null, notes: [] }), "Reload to get the latest version");
	assert.equal(
		updatePreview({ release: null, notes: NOTES }),
		"Reload to get the latest version · Snooze in Settings lists later.",
	);
});

test("What's new stays in the reader only while the notice stands", () => {
	const base = { available: true, dismissed: false, reloading: false, lists: 1, open: true };
	assert.equal(isUpdateReaderOpen(base), true);
	assert.equal(isUpdateReaderOpen({ ...base, open: false }), false);
	assert.equal(isUpdateReaderOpen({ ...base, dismissed: true }), false);
	assert.equal(isUpdateReaderOpen({ ...base, reloading: true }), false);
	assert.equal(isUpdateReaderOpen({ ...base, available: false }), false);
});
