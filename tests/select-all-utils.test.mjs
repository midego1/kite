import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-select-all-utils-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/select-all-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { resolveAllMatchingMessages, SELECT_ALL_MAX_MESSAGES } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

/** A page of `limit` messages, with `total` and `nextCursor` as the server would report them. */
function page(count, total, nextCursor) {
	return {
		messages: Array.from({ length: count }, (_, index) => ({ id: `m${index}` })),
		total,
		nextCursor,
	};
}

function mockPages(pages) {
	let call = 0;
	return async () => {
		const body = pages[Math.min(call, pages.length - 1)];
		call += 1;
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	};
}

test("a folder with fewer matches than the cap is never truncated", async (t) => {
	t.mock.method(globalThis, "fetch", mockPages([page(3, 3, null)]));
	const result = await resolveAllMatchingMessages("inbox", null, {});
	assert.equal(result.messages.length, 3);
	assert.equal(result.truncated, false);
});

test("a folder whose count lands exactly on the cap is not truncated, even though the last page still carries a cursor", async (t) => {
	// Page size is 100 inside the module; this uses two pages just past and up to a small cap-equivalent total
	// by having the server's own `total` match what was collected, the same shape a 1,000-match folder gives.
	t.mock.method(
		globalThis,
		"fetch",
		mockPages([page(100, 150, "cursor-1"), page(50, 150, "cursor-2-even-though-nothing-is-left")]),
	);
	const result = await resolveAllMatchingMessages("inbox", null, {});
	assert.equal(result.messages.length, 150);
	assert.equal(result.truncated, false);
});

test("a folder with more than the cap is truncated at it", async (t) => {
	const pages = [];
	for (let collected = 0; collected < SELECT_ALL_MAX_MESSAGES; collected += 100) {
		pages.push(page(100, SELECT_ALL_MAX_MESSAGES + 500, `cursor-${collected}`));
	}
	t.mock.method(globalThis, "fetch", mockPages(pages));
	const result = await resolveAllMatchingMessages("inbox", null, {});
	assert.equal(result.messages.length, SELECT_ALL_MAX_MESSAGES);
	assert.equal(result.truncated, true);
});

test("a failed page throws instead of returning a partial selection silently", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
	await assert.rejects(() => resolveAllMatchingMessages("inbox", null, {}));
});
