import assert from "node:assert/strict";
import test from "node:test";
import { moveItem, resolveLayout } from "../src/components/reorderable-list-utils.ts";

const defaults = {
	main: ["/inbox", "/for-you", "/starred", "/snoozed", "/sent"],
	more: ["/drafts", "/archive", "/spam"],
};

test("without a saved layout the defaults are used as they are", () => {
	assert.deepEqual(resolveLayout(defaults, {}), defaults);
});

test("an item a saved layout has never seen goes right after its default neighbour, not to the end", () => {
	const stored = { main: ["/sent", "/inbox", "/starred", "/snoozed"], more: ["/spam", "/drafts", "/archive"] };
	assert.deepEqual(resolveLayout(defaults, stored), {
		main: ["/sent", "/inbox", "/for-you", "/starred", "/snoozed"],
		more: ["/spam", "/drafts", "/archive"],
	});
});

test("when the earlier neighbours moved to another list, the new item goes before its next neighbour", () => {
	const stored = { main: ["/sent", "/starred", "/snoozed"], more: ["/inbox", "/drafts", "/archive", "/spam"] };
	assert.deepEqual(resolveLayout(defaults, stored).main, ["/sent", "/for-you", "/starred", "/snoozed"]);
});

test("with no neighbour left in its list the new item goes at the end", () => {
	const stored = { main: [], more: ["/inbox", "/starred", "/snoozed", "/sent", "/drafts", "/archive", "/spam"] };
	assert.deepEqual(resolveLayout(defaults, stored).main, ["/for-you"]);
});

test("a position the user saved is kept, in either list", () => {
	const moved = moveItem(resolveLayout(defaults, {}), "/for-you", "main", null);
	assert.deepEqual(resolveLayout(defaults, moved).main, ["/inbox", "/starred", "/snoozed", "/sent", "/for-you"]);
	const intoMore = moveItem(resolveLayout(defaults, {}), "/for-you", "more", "/archive");
	assert.deepEqual(resolveLayout(defaults, intoMore), {
		main: ["/inbox", "/starred", "/snoozed", "/sent"],
		more: ["/drafts", "/for-you", "/archive", "/spam"],
	});
});

test("unknown and repeated ids in a saved layout are dropped", () => {
	const stored = { main: ["/inbox", "/gone", "/inbox", "/for-you"], more: ["/for-you", "/spam"] };
	assert.deepEqual(resolveLayout(defaults, stored), {
		main: ["/inbox", "/for-you", "/starred", "/snoozed", "/sent"],
		more: ["/drafts", "/archive", "/spam"],
	});
});
