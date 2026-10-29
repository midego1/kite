import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Saved AI provider connections (migration 0077), so an admin can switch providers without typing a key again.
 * At most one row is active: switching is one UPDATE that sets `active = (id = ?)` on every row. (A partial unique
 * index cannot back it, because SQLite checks UNIQUE row by row and would refuse that statement midway.) Before 0077,
 * or while no row is active, the provider is read from the legacy `app_settings.agent_*` columns, which 0077 copies
 * into the first row; they are cleared once a saved provider is in use.
 */
export const agentProviders = sqliteTable(
	"agent_providers",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		provider: text("provider", { enum: ["cloudflare", "compatible"] }).notNull(),
		/** Null for Workers AI. */
		preset: text("preset", { enum: ["haimaker", "anthropic", "openai", "openrouter", "groq", "custom"] }),
		baseUrl: text("base_url"),
		/** Sealed with APP_ENCRYPTION_KEY like `app_settings.agent_api_key`; never returned to a client. */
		apiKey: text("api_key"),
		/** Comma-separated model ids; the first is the default. */
		model: text("model").notNull(),
		/** JSON: USD per 1M tokens and the reasoning hint per model, as `app_settings.agent_model_rates`. */
		modelRates: text("model_rates"),
		active: integer("active", { mode: "boolean" }).notNull().default(false),
		/** Milliseconds, so providers saved within the same second keep their order. */
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("agent_providers_active_idx").on(t.active), index("agent_providers_created_idx").on(t.createdAt)],
);
