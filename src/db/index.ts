import { drizzle } from "drizzle-orm/d1";
import * as coreTables from "@/db/schema";
import * as autoReadTables from "@/db/schema/agent-auto-read";
import * as driveTables from "@/db/schema/drive";
import * as financeTables from "@/db/schema/finance";
import * as moduleTables from "@/db/schema/modules";
import * as storageTables from "@/db/schema/storage";

const schema = {
	...coreTables,
	...autoReadTables,
	...moduleTables,
	...financeTables,
	...driveTables,
	...storageTables,
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
