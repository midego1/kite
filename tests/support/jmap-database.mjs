import { join } from "node:path";
import { bundleModules, root } from "./modules-bundle.mjs";

export const jmap = await bundleModules("kite-jmap-db-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["getDb", "src/db/index.ts"],
	["SUPPORTED_CAPABILITIES, processRequest, validateRequest", "src/lib/jmap/processor.ts"],
	["loadMessages", "src/lib/jmap/emails.ts"],
	["loadAttachmentsByMessage", "src/lib/jmap/email-objects.ts"],
]);

export const D1_BOUND_PARAMETER_LIMIT = 100;

/**
 * Makes the SQLite stand-in refuse a statement with more bound parameters than D1 accepts, with the
 * kind of message D1 gives (the SQL and its values), and records the largest count it was asked for.
 */
export function limitBoundParameters(database, limit = D1_BOUND_PARAMETER_LIMIT) {
	const stats = { maxBound: 0, statements: 0 };
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			stats.statements += 1;
			stats.maxBound = Math.max(stats.maxBound, values.length);
			if (values.length > limit)
				throw new Error(`D1_ERROR: too many SQL variables: ${sql} params: ${JSON.stringify(values)}`);
			return bind(...values);
		};
		return statement;
	};
	return stats;
}

/** A migrated in-memory database with one admin, one domain and `mailboxCount` mailboxes the admin owns. */
export async function jmapContext(t, { mailboxCount = 1 } = {}) {
	const database = new jmap.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await jmap.applyMigrations(database, join(root, "drizzle/migrations"));
	const mailboxIds = Array.from({ length: mailboxCount }, (_, index) => `mbx-${String(index).padStart(3, "0")}`);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			${mailboxIds.map((id) => `('${id}', 'owner', 'domain-1', '${id}', 'personal', 1)`).join(",\n\t\t\t")};
	`);
	const user = { id: "owner", email: "owner@example.com", role: "admin", isPrimaryAdmin: true, disabled: false };
	const ctx = {
		env: { DB: database },
		db: jmap.getDb({ DB: database }),
		auth: { userId: "owner", email: "owner@example.com", scopes: ["jmap"], mailboxIds: null, user },
		accountId: "owner",
		origin: "https://kite.test",
		createdIds: {},
	};
	return { database, ctx, mailboxIds };
}
