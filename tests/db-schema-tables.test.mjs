import assert from "node:assert/strict";
import test from "node:test";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { bundleModules } from "./support/modules-bundle.mjs";

// Narrow views (`message-bodies.ts`, `spam-policy.ts`, and others) deliberately declare a second Drizzle table
// object for an existing SQL table's columns subset, and are kept out of `schema` for exactly this reason: two
// table objects naming the same SQL table confuse `drizzle-kit generate` (which table is the real one?) and the
// relational query builder (`db.query.<key>`, keyed by the JS property, not the SQL name). `driveItemColdView`
// (`src/db/schema/drive.ts`) is one of these and is excluded in `src/db/index.ts`; this guards that no table
// object sharing a name with another ever slips into the merged schema again, from any schema file.
const { schema } = await bundleModules("kite-db-schema-tables-", [["schema", "src/db/index.ts"]]);

test("every table in the merged schema names a distinct SQL table", () => {
	const namesByKey = Object.entries(schema)
		.filter(([, value]) => is(value, SQLiteTable))
		.map(([key, value]) => [key, getTableName(value)]);
	const seen = new Map();
	for (const [key, name] of namesByKey) {
		assert.ok(!seen.has(name), `"${key}" and "${seen.get(name)}" both name the SQL table "${name}"`);
		seen.set(name, key);
	}
	assert.ok(namesByKey.length > 50, "sanity check: the merged schema should still hold the whole table set");
});
