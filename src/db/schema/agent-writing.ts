import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./index";
import { instructionColumns } from "./instruction-columns";

/**
 * A user's own AI preferences (migration 0069), private to them: personal instructions that apply in every
 * mailbox they work in, and the writing style opt-in. A separate table rather than `users` columns, so whole-row
 * reads of `users` keep working on a database whose migrations are behind. No row means everything empty and off.
 */
export const userAiSettings = sqliteTable("user_ai_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	writingStyleEnabled: integer("writing_style_enabled", { mode: "boolean" }).notNull().default(false),
	...instructionColumns(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});
