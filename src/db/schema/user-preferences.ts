import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./index";

/**
 * A user's layout preferences (migration 0080), so they follow the account to every device: the reading pane,
 * list density, conversation view and the message list's size. `layout` is a JSON object validated by
 * `parseLayoutPreferences` (`src/lib/preferences/layout-utils.ts`); a key that is absent was never chosen. A table
 * of its own rather than `users` columns, so whole-row reads of `users` keep working while the migration is pending.
 */
export const userPreferences = sqliteTable("user_preferences", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	layout: text("layout").notNull().default("{}"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});
