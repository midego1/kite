import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	DEFAULT_LEFTOVER_SETTINGS,
	isKeptReason,
	KEPT_REASON_TEXT,
	LEFTOVER_KEPT_REASONS,
	parseLeftoverSettingsInput,
	parseLeftoverState,
	planLeftover,
	restoredSince,
	tallyOutcomes,
	graceFormToBody,
	keptReasonsText,
	leftoverRunText,
	remainingText,
} = await bundleModules("kite-storage-cold-leftovers-utils-", [
	[
		"DEFAULT_LEFTOVER_SETTINGS, isKeptReason, KEPT_REASON_TEXT, LEFTOVER_KEPT_REASONS, parseLeftoverSettingsInput, parseLeftoverState, planLeftover, restoredSince, tallyOutcomes",
		"src/lib/storage/cold-leftovers-utils.ts",
	],
	["graceFormToBody, keptReasonsText, leftoverRunText, remainingText", "src/app/(admin)/storage/leftovers-utils.ts"],
]);

const facts = (overrides) => ({
	candidateStore: "sto_c",
	rowStore: "sto_c",
	created: false,
	referenced: true,
	driveRowStore: null,
	...overrides,
});

test("the copy a live row reads is never planned for deletion", () => {
	assert.deepEqual(planLeftover(facts({})), { kind: "live" }, "the location of a referenced key");
	assert.deepEqual(
		planLeftover(facts({ rowStore: "sto_d", driveRowStore: "sto_c" })),
		{ kind: "live" },
		"Drive reads its own row's store first, whatever object_locations says",
	);
});

test("a referenced key with no row whose only copy found is the leftover keeps it", () => {
	assert.deepEqual(planLeftover(facts({ created: true })), { kind: "only_copy" });
});

test("a copy superseded by another store, or of a key nothing references, may be deleted under further checks", () => {
	assert.deepEqual(planLeftover(facts({ rowStore: "sto_d" })), { kind: "superseded", otherStoreId: "sto_d" });
	assert.deepEqual(planLeftover(facts({ rowStore: "default", created: true, referenced: false })), {
		kind: "superseded",
		otherStoreId: "default",
	});
	assert.deepEqual(planLeftover(facts({ referenced: false })), { kind: "unreferenced" });
	assert.deepEqual(planLeftover(facts({ referenced: false, created: true })), { kind: "unreferenced" });
});

test("a restore at or after the first unreferenced sighting makes that sighting worthless", () => {
	assert.equal(restoredSince(100, null), false);
	assert.equal(restoredSince(100, 99), false);
	assert.equal(restoredSince(100, 100), true);
	assert.equal(restoredSince(100, 200), true);
});

test("stored settings default field by field and never throw", () => {
	assert.deepEqual(parseLeftoverState(null), { ...DEFAULT_LEFTOVER_SETTINGS, lastRun: null });
	assert.deepEqual(parseLeftoverState("not json"), { ...DEFAULT_LEFTOVER_SETTINGS, lastRun: null });
	assert.deepEqual(parseLeftoverState("[1]"), { ...DEFAULT_LEFTOVER_SETTINGS, lastRun: null });
	assert.deepEqual(parseLeftoverState(JSON.stringify({ automatic: "yes", graceDays: 0 })), {
		...DEFAULT_LEFTOVER_SETTINGS,
		lastRun: null,
	});
	const lastRun = { at: "2026-11-10T00:00:00.000Z", trigger: "manual", deleted: 1 };
	assert.deepEqual(parseLeftoverState(JSON.stringify({ automatic: true, graceDays: 30, lastRun })), {
		automatic: true,
		graceDays: 30,
		lastRun,
	});
	assert.equal(DEFAULT_LEFTOVER_SETTINGS.automatic, false, "the automatic cleanup is off by default");
});

test("settings input is validated", () => {
	assert.deepEqual(parseLeftoverSettingsInput({ automatic: true, graceDays: 7 }), {
		ok: true,
		value: { automatic: true, graceDays: 7 },
	});
	for (const bad of [
		null,
		"x",
		{ automatic: 1, graceDays: 7 },
		{ automatic: false, graceDays: 0 },
		{ automatic: false, graceDays: 1.5 },
		{ automatic: false, graceDays: 366 },
	])
		assert.equal(parseLeftoverSettingsInput(bad).ok, false, JSON.stringify(bad));
});

test("outcomes add up to a run summary", () => {
	assert.deepEqual(tallyOutcomes(["deleted", "deleted", "cleared", "backup", "backup", "busy"]), {
		checked: 6,
		deleted: 2,
		cleared: 1,
		kept: { backup: 2, busy: 1 },
	});
	assert.deepEqual(tallyOutcomes([]), { checked: 0, deleted: 0, cleared: 0, kept: {} });
});

test("every kept reason has words for Admin → Storage", () => {
	for (const reason of LEFTOVER_KEPT_REASONS) {
		assert.equal(isKeptReason(reason), true);
		assert.ok(KEPT_REASON_TEXT[reason]);
	}
	assert.equal(isKeptReason("deleted"), false);
	assert.equal(isKeptReason(3), false);
});

test("the admin page describes a run in one sentence", () => {
	const run = { checked: 5, deleted: 2, cleared: 1, kept: { only_copy: 1, backup: 1 }, skipped: null };
	assert.equal(
		leftoverRunText(run),
		"Deleted 2 leftover copies. 1 copy was already gone or in use again. Kept 2: no other readable copy was found (1); a backup you keep could still restore a reference to it (1).",
	);
	assert.equal(
		leftoverRunText({ checked: 1, deleted: 1, cleared: 2, kept: {}, skipped: null }),
		"Deleted 1 leftover copy. 2 copies were already gone or in use again.",
	);
	assert.equal(leftoverRunText({ ...run, checked: 0 }), "No leftover copies are past the grace period yet.");
	assert.match(leftoverRunText({ ...run, skipped: "restore" }), /backup restore/);
	assert.match(leftoverRunText({ ...run, skipped: "unsupported" }), /database update/);
	assert.equal(keptReasonsText({ busy: 0 }), "");
	assert.equal(keptReasonsText({ busy: 1, backup: 3 }).startsWith(KEPT_REASON_TEXT.backup), true, "most common first");
});

test("the admin page says what is left after a manual run", () => {
	assert.equal(remainingText(0, true), "No leftover copies are left on this store.");
	assert.equal(remainingText(0, false), "No leftover copies are left.");
	assert.equal(remainingText(1, true), "1 leftover copy is still tracked on this store.");
	assert.equal(remainingText(1200, false), "1,200 leftover copies are still tracked.");
});

test("the grace period field accepts whole days within the limits", () => {
	const limits = { min: 1, max: 365 };
	assert.deepEqual(graceFormToBody({ automatic: true, graceDays: " 14 " }, limits), {
		body: { automatic: true, graceDays: 14 },
	});
	for (const graceDays of ["", "0", "2.5", "366", "x"])
		assert.deepEqual(graceFormToBody({ automatic: false, graceDays }, limits), {
			error: "Enter a grace period from 1 to 365 days",
		});
});
