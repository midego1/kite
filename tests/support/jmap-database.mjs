import { join } from "node:path";
import { bundleModules, root } from "./modules-bundle.mjs";

export const jmap = await bundleModules("kite-jmap-db-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["getDb", "src/db/index.ts"],
	["SUPPORTED_CAPABILITIES, processRequest, validateRequest", "src/lib/jmap/processor.ts"],
]);

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
