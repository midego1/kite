/** Every column migration 0069 adds, by table; `user_ai_settings` is created by it and checked by one column. */
const MIGRATION_0069_COLUMNS: Record<string, readonly string[]> = {
	mailbox_agent_settings: ["chat_instructions", "draft_instructions", "summary_instructions"],
	app_settings: ["agent_auto_read_token_cap", "agent_chat_token_cap"],
	user_ai_settings: ["user_id"],
};

/** Databases known to have applied 0069; migrations only add, so a hit is final for the isolate's life. */
const appliedDatabases = new WeakSet<object>();

/**
 * Whether migration 0069 (AI writing) is applied, so its fields can be saved. It reads only the tables' column
 * lists (`PRAGMA table_info` returns no rows for a missing table), never a column that may be missing.
 */
export async function aiWritingMigrationApplied(env: CloudflareEnv): Promise<boolean> {
	if (appliedDatabases.has(env.DB)) return true;
	for (const [table, columns] of Object.entries(MIGRATION_0069_COLUMNS)) {
		const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
		const names = new Set(results.map((column) => column.name));
		if (!columns.every((column) => names.has(column))) return false;
	}
	appliedDatabases.add(env.DB);
	return true;
}
