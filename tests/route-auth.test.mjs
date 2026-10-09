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
