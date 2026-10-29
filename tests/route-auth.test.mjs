import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const API_ROOT = path.resolve("src/app/api");

function routeFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...routeFiles(full));
		else if (entry.name === "route.ts" || entry.name === "utils.ts") files.push(full);
	}
	return files;
}

test("API route files do not use requireUser, which throws a 500 for unauthenticated callers", () => {
	const files = routeFiles(API_ROOT);
	assert.ok(files.length > 50, "route enumeration found too few files");
	const offenders = files
		.filter((file) => /\brequireUser\b/.test(readFileSync(file, "utf8")))
		.map((file) => path.relative(process.cwd(), file));
	assert.deepEqual(offenders, [], `use requireSessionUser or requireSessionAdmin in: ${offenders.join(", ")}`);
});

test("requireSessionAdmin is exported from the shared session auth module", () => {
	const source = readFileSync("src/lib/api/auth.ts", "utf8");
	assert.match(source, /export async function requireSessionAdmin\(/);
});

test("restore routes check the session mutation origin after authenticating", () => {
	// A restore replaces the whole database, so a cross-site POST carrying the owner's cookie must be refused.
	for (const file of [
		"src/app/api/backups/restore/route.ts",
		"src/app/api/backups/[id]/restore/route.ts",
		"src/app/api/backups/restore/recover/route.ts",
	]) {
		const source = readFileSync(file, "utf8");
		const auth = source.indexOf("requireSessionAdmin(env, request, isPrimaryAdmin)");
		const origin = source.indexOf("if (!hasValidSessionMutationOrigin(request))");
		assert.ok(auth > 0, `${file} authenticates the primary admin`);
		assert.ok(origin > auth, `${file} checks the origin after authenticating`);
		assert.ok(origin < source.search(/\bstart\w+\(env/), `${file} checks the origin before starting the restore`);
	}
});

test("the admin migration route refuses to apply anything while a restore runs", () => {
	const source = readFileSync("src/app/api/admin/migrations/POST.ts", "utf8");
	const guard = source.indexOf("if (await restoreBlocksMigrations(env.BUCKET))");
	assert.ok(guard > source.indexOf("authorizeMigrationRequest(request)"), "after authorizing");
	assert.ok(guard < source.indexOf("createSafetyBackup("), "before the backup and the migrations");
	assert.match(source.slice(guard, guard + 300), /status: 409/);
});
