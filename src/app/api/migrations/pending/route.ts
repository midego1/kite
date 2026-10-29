import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { maybeAutoApplyPendingMigrations } from "@/lib/migrations/auto-apply";
import { getPendingMigrationStatus } from "@/lib/migrations/pending";
import { pendingStatusOptions } from "@/lib/migrations/pending-utils";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * How many database migrations this release still has to apply, for the banner
 * in the mailbox. Any signed-in user may see the count; who gets more is
 * `pendingStatusOptions`. The count reads only `sqlite_master` and `d1_migrations`;
 * the primary admin's name and address, for other admins, read `users` only after
 * checking its columns exist, so the answer comes while the schema is behind.
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

	const status = await getPendingMigrationStatus(env.DB, pendingStatusOptions(auth.user));
	return Response.json(status, { headers: NO_STORE });
}
