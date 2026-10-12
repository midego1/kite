import { drizzle } from "drizzle-orm/d1";
import * as coreTables from "@/db/schema";
import * as autoReadTables from "@/db/schema/agent-auto-read";
import * as moduleTables from "@/db/schema/modules";

const schema = { ...coreTables, ...autoReadTables, ...moduleTables };

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
