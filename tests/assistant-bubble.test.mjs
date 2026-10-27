import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { assistantBubblePlacement } = await bundleModules("kite-assistant-bubble-", [
	["assistantBubblePlacement", "src/app/(dashboard)/floating-assistant-utils.ts"],
]);

const base = { open: false, fullSize: false, composing: false, composerPlacement: "popup" };

test("the bubble sits in the corner with no composer open", () => {
	assert.equal(assistantBubblePlacement(base), "corner");
});

test("the bubble waits while a floating composer is open, so it never covers the send row", () => {
	assert.equal(assistantBubblePlacement({ ...base, composing: true, composerPlacement: "popup" }), "hidden");
});

test("a reply docked in the reader keeps the bubble, above its footer while it is expanded", () => {
	assert.equal(assistantBubblePlacement({ ...base, composing: true, composerPlacement: "inline" }), "above-reply");
});

test("a collapsed or parked docked reply leaves the bubble in the corner", () => {
	assert.equal(assistantBubblePlacement({ ...base, composing: false, composerPlacement: "inline" }), "corner");
});

test("an open assistant keeps its bubble to minimize it, even over a floating composer", () => {
	assert.equal(
		assistantBubblePlacement({ ...base, open: true, composing: true, composerPlacement: "popup" }),
		"corner",
	);
	assert.equal(
		assistantBubblePlacement({ ...base, open: true, composing: true, composerPlacement: "inline" }),
		"corner",
	);
});

test("the full-size assistant hides the bubble", () => {
	assert.equal(assistantBubblePlacement({ ...base, open: true, fullSize: true }), "hidden");
});
