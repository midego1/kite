import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-banner-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/alerts-banner-utils.ts")],
	outfile: join(bundleDirectory, "banner.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const {
	ACTIVE_ALERTS_REFRESH_MS,
	parseActiveAlerts,
	readDismissedSignature,
	shouldShowAlertsBanner,
	storeDismissedSignature,
} = await import(pathToFileURL(join(bundleDirectory, "banner.mjs")).href);

const stuck = { rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 1, href: "/admin" };

function memoryStorage(initial = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		getItem: (key) => (values.has(key) ? values.get(key) : null),
		setItem: (key, value) => values.set(key, String(value)),
	};
}

const throwingStorage = {
	getItem() {
		throw new Error("blocked");
	},
	setItem() {
		throw new Error("blocked");
	},
};

test("refreshes every five minutes", () => {
	assert.equal(ACTIVE_ALERTS_REFRESH_MS, 300_000);
});

test("parseActiveAlerts keeps well-formed alerts and drops the rest", () => {
	const parsed = parseActiveAlerts({
		enabled: true,
		alerts: [stuck, { rule: "x", name: "Off-site", count: 1, href: "https://example.com" }, { name: "partial" }, null],
		signature: "outbound_stuck:active",
	});
	assert.deepEqual(parsed, { enabled: true, alerts: [stuck], signature: "outbound_stuck:active" });
});

test("parseActiveAlerts reads unexpected bodies as nothing active", () => {
	const empty = { enabled: false, alerts: [], signature: null };
	assert.deepEqual(parseActiveAlerts(null), empty);
	assert.deepEqual(parseActiveAlerts("oops"), empty);
	assert.deepEqual(parseActiveAlerts({ enabled: "yes", alerts: "none", signature: "" }), empty);
	assert.deepEqual(parseActiveAlerts({ enabled: false, alerts: [], signature: null }), empty);
});

test("shouldShowAlertsBanner shows active alerts until their signature is dismissed", () => {
	const data = { enabled: true, alerts: [stuck], signature: "outbound_stuck:active" };
	assert.equal(shouldShowAlertsBanner(data, null), true);
	assert.equal(shouldShowAlertsBanner(data, "outbound_stuck:active"), false);
	assert.equal(shouldShowAlertsBanner(data, "backup_failed:bak_1"), true);
});

test("shouldShowAlertsBanner hides when nothing is active or loaded", () => {
	assert.equal(shouldShowAlertsBanner(undefined, null), false);
	assert.equal(shouldShowAlertsBanner({ enabled: true, alerts: [], signature: null }, null), false);
	assert.equal(shouldShowAlertsBanner({ enabled: true, alerts: [stuck], signature: null }, null), false);
	assert.equal(shouldShowAlertsBanner({ enabled: false, alerts: [], signature: null }, null), false);
});

test("a stored dismissal round-trips and a new signature replaces it", () => {
	const storage = memoryStorage();
	assert.equal(readDismissedSignature(storage), null);
	storeDismissedSignature(storage, "outbound_stuck:active");
	assert.equal(storage.values.get("kite-dismissed-alerts"), "outbound_stuck:active");
	assert.equal(readDismissedSignature(storage), "outbound_stuck:active");
	storeDismissedSignature(storage, "backup_failed:bak_1|outbound_stuck:active");
	assert.equal(readDismissedSignature(storage), "backup_failed:bak_1|outbound_stuck:active");
});

test("missing or failing storage never throws", () => {
	assert.equal(readDismissedSignature(undefined), null);
	assert.equal(readDismissedSignature(throwingStorage), null);
	assert.doesNotThrow(() => storeDismissedSignature(undefined, "sig"));
	assert.doesNotThrow(() => storeDismissedSignature(throwingStorage, "sig"));
});
