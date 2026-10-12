import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migrations-banner-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/migrations-banner-utils.ts")],
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
const {
	PENDING_MIGRATIONS_REFRESH_MS,
	migrationApplySummary,
	migrationsBannerContent,
	parsePendingMigrations,
	shouldShowMigrationsBanner,
} = await import(pathToFileURL(join(bundleDirectory, "banner.mjs")).href);

test("refreshes every five minutes", () => {
	assert.equal(PENDING_MIGRATIONS_REFRESH_MS, 300_000);
});

test("parsePendingMigrations keeps a count and only well-formed names", () => {
	assert.deepEqual(parsePendingMigrations({ pending: 2 }), { pending: 2 });
	assert.deepEqual(parsePendingMigrations({ pending: 2, names: ["0001_a.sql", 7, "0002_b.sql"] }), {
		pending: 2,
		names: ["0001_a.sql", "0002_b.sql"],
	});
	assert.deepEqual(parsePendingMigrations({ pending: 1.6 }), { pending: 1 });
	assert.deepEqual(parsePendingMigrations({ pending: 3, names: [] }), { pending: 3 });
});

test("parsePendingMigrations reads unexpected bodies as up to date", () => {
	assert.deepEqual(parsePendingMigrations(null), { pending: 0 });
	assert.deepEqual(parsePendingMigrations("oops"), { pending: 0 });
	assert.deepEqual(parsePendingMigrations({ pending: -4 }), { pending: 0 });
	assert.deepEqual(parsePendingMigrations({ pending: "3" }), { pending: 0 });
	assert.deepEqual(parsePendingMigrations({ pending: Number.POSITIVE_INFINITY }), { pending: 0 });
});

test("shouldShowMigrationsBanner only shows a schema that is behind", () => {
	assert.equal(shouldShowMigrationsBanner({ pending: 1 }), true);
	assert.equal(shouldShowMigrationsBanner({ pending: 0 }), false);
	// A status that could not be read stays quiet instead of warning about nothing.
	assert.equal(shouldShowMigrationsBanner(undefined), false);
});

test("the banner explains what is waiting and what breaks until it is applied", () => {
	assert.deepEqual(migrationsBannerContent(1), {
		title: "Kite was updated, but the database still needs 1 update",
		body: "Until they are applied, new email may not appear and some pages may fail.",
	});
	assert.equal(migrationsBannerContent(3).title, "Kite was updated, but the database still needs 3 updates");
});

test("the apply summary names what happened", () => {
	assert.equal(
		migrationApplySummary({ applied: ["0001_a.sql"], backupId: "bak_1" }),
		"1 database update applied. A safety backup was saved first.",
	);
	assert.equal(
		migrationApplySummary({ applied: ["0001_a.sql", "0002_b.sql"], backupId: null }),
		"2 database updates applied.",
	);
	assert.equal(migrationApplySummary({}), "0 database updates applied.");
});
