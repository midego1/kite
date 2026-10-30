import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-reload-flight-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/reload-flight-utils.ts")],
	outfile: join(bundleDirectory, "flight.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const {
	RELOAD_FLIGHT_ANNOUNCEMENT,
	RELOAD_FLIGHT_EXPIRE_MS,
	isFlightEnd,
	once,
	planReloadFlight,
	prefersReducedMotion,
} = await import(pathToFileURL(join(bundleDirectory, "flight.mjs")).href);

test("the flight is quick and the fallback reload comes soon after it", () => {
	const plan = planReloadFlight({ reducedMotion: false });
	assert.equal(plan.animate, true);
	assert.ok(plan.durationMs >= 600 && plan.durationMs <= 900, "600 to 900 ms");
	assert.ok(plan.fallbackMs > plan.durationMs, "the fallback waits for the flight");
	assert.ok(plan.fallbackMs <= 1_500, "the reload never waits longer than 1.5 s");
	assert.equal(RELOAD_FLIGHT_ANNOUNCEMENT, "Reloading…");
});

test("a reload that has not replaced the page after ten seconds counts as cancelled", () => {
	assert.equal(RELOAD_FLIGHT_EXPIRE_MS, 10_000);
	// Longer than the fallback timer, so the scene never expires while the reload is still on its way.
	assert.ok(RELOAD_FLIGHT_EXPIRE_MS > planReloadFlight({ reducedMotion: false }).fallbackMs);
});

test("planReloadFlight skips the flight and reloads at once under reduced motion", () => {
	assert.deepEqual(planReloadFlight({ reducedMotion: true }), { animate: false, durationMs: 0, fallbackMs: 0 });
});

test("prefersReducedMotion reads the media query and never throws", () => {
	const queries = [];
	const matchMedia = (query) => {
		queries.push(query);
		return { matches: true };
	};
	assert.equal(prefersReducedMotion(matchMedia), true);
	assert.deepEqual(queries, ["(prefers-reduced-motion: reduce)"]);
	assert.equal(
		prefersReducedMotion(() => ({ matches: false })),
		false,
	);
	assert.equal(prefersReducedMotion(undefined), false);
	assert.equal(
		prefersReducedMotion(() => {
			throw new Error("no media queries here");
		}),
		false,
	);
});

test("once runs the reload a single time however often the flight end and the fallback ask", () => {
	let reloads = 0;
	const reload = once(() => {
		reloads += 1;
	});
	reload();
	reload();
	reload();
	assert.equal(reloads, 1);
});

test("isFlightEnd accepts only the kite's own animation", () => {
	assert.equal(isFlightEnd("reload-flight-kite"), true);
	assert.equal(isFlightEnd("reload-flight-tail"), false);
	assert.equal(isFlightEnd("reload-flight-fade"), false);
	assert.equal(isFlightEnd(""), false);
});
