import { getTableColumns, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { users } from "@/db/schema";
import { missingColumnFromError } from "./user-lookup-utils";

type User = typeof users.$inferSelect;
type Db = ReturnType<typeof getDb>;

/**
 * One user row. A new deploy runs before an admin applies its migrations, so a column added
 * to `users` may not exist yet; this retries without it and fills in the column's default,
 * which keeps sign-in (and with it the "Update database" button) working in that window.
 */
export async function findUser(db: Db, where: SQL | undefined): Promise<User | undefined> {
	try {
		const [user] = await db.select().from(users).where(where).limit(1);
		return user;
	} catch (error) {
		const missing = new Set<string>();
		let lastError: unknown = error;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const column = missingColumnFromError(lastError);
			if (!column || missing.has(column)) throw error;
			missing.add(column);
			const columns = getTableColumns(users);
			const selection = Object.fromEntries(
				Object.entries(columns).filter(([, definition]) => !missing.has(definition.name)),
			);
			try {
				const [row] = await db.select(selection).from(users).where(where).limit(1);
				if (!row) return undefined;
				const filled: Record<string, unknown> = { ...row };
				for (const [key, definition] of Object.entries(columns)) {
					if (missing.has(definition.name)) filled[key] = definition.default ?? null;
				}
				return filled as User;
			} catch (retryError) {
				lastError = retryError;
			}
		}
		throw error;
	}
}
