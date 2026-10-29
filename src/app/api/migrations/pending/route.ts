import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isAdmin, isPrimaryAdmin } from "@/lib/auth/admin";
import { maybeAutoApplyPendingMigrations } from "@/lib/migrations/auto-apply";
import { getPendingMigrationStatus } from "@/lib/migrations/pending";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * How many database migrations this release still has to apply, for the banner
 * in the mailbox. Any signed-in user may see the count; its names go only to
 * the primary admin, the account that can apply them, and that account's name
 * and address only to the other admins, so they know whom to ask. The check reads
 * `d1_migrations` alone, so it answers while the schema is behind.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) {
		auth.error.headers.set("Cache-Control", "no-store");
		return auth.error;
	}

	// With AUTO_APPLY_MIGRATIONS set, the first status check of an isolate applies them.
	await maybeAutoApplyPendingMigrations(env);

	const primary = isPrimaryAdmin(auth.user);
	const status = await getPendingMigrationStatus(env.DB, {
		includeNames: primary,
		includeApplier: isAdmin(auth.user) && !primary,
	});
	return Response.json(status, { headers: NO_STORE });
}
