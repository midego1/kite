import { drizzle } from "drizzle-orm/d1";
import * as coreTables from "@/db/schema";
import * as autoReadTables from "@/db/schema/agent-auto-read";
import * as writingTables from "@/db/schema/agent-writing";
import * as driveTables from "@/db/schema/drive";
import * as financeTables from "@/db/schema/finance";
import * as moduleTables from "@/db/schema/modules";
import * as screenerTables from "@/db/schema/screener";
import * as storageTables from "@/db/schema/storage";

const schema = {
	...coreTables,
	...autoReadTables,
	...writingTables,
	...moduleTables,
	...financeTables,
	...driveTables,
	...storageTables,
	...screenerTables,
};

export type AppDatabase = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export function getDb(env: Pick<CloudflareEnv, "DB">) {
	if (!env.DB) {
		throw new Error("No database binding configured");
	}
	return createDb(env.DB);
}

export { schema };
