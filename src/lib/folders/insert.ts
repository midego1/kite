import { sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { folders } from "@/db/schema";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { DEFAULT_FOLDER_COLOR } from "./colors";

type Db = ReturnType<typeof getDb>;

/**
 * Inserts a folder. Before migration 0086 adds `color_is_custom` the insert is retried without it: the folder is
 * stored with its colour and reads as not picked, instead of failing in the window between a deploy and its migration.
 * Resolves to whether the folder was stored as picked, which is what the caller should report.
 * (Drizzle writes a column's default explicitly, so leaving the key out of `values` would not help.)
 */
export async function insertFolder(db: Db, values: typeof folders.$inferInsert): Promise<boolean> {
	try {
		await db.insert(folders).values(values);
		return values.colorIsCustom === true;
	} catch (error) {
		if (missingColumnFromError(error) !== "color_is_custom") throw error;
		await db.run(
			sql`insert into ${folders} (id, user_id, mailbox_id, name, color, created_at) values (${values.id}, ${values.userId}, ${values.mailboxId}, ${values.name}, ${values.color ?? DEFAULT_FOLDER_COLOR}, ${Math.floor((values.createdAt ?? new Date()).getTime() / 1000)})`,
		);
		return false;
	}
}
