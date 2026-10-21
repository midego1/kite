import type { SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { users } from "@/db/schema";
import { selectRow } from "@/lib/db/pending-columns";

type User = typeof users.$inferSelect;
type Db = ReturnType<typeof getDb>;

/**
 * One user row. A new deploy runs before an admin applies its migrations, so a column added
 * to `users` may not exist yet; this retries without it and fills in the column's default,
 * which keeps sign-in (and with it the "Update database" button) working in that window.
 */
export async function findUser(db: Db, where: SQL | undefined): Promise<User | undefined> {
	return selectRow(db, users, where);
}
