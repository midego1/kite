import { listApplicationTables } from "@/lib/backups/export";
import { restoreBlocksMigrations } from "@/lib/backups/restore-job-store";
import { createSafetyBackup } from "@/lib/backups/safety";
import { applyPendingMigrations, getMigrationStatus } from "./service";

/** The single in-flight run for this isolate; cleared again when a run fails. */
let attempted: Promise<void> | null = null;

/**
 * Whether this install applies pending migrations by itself. It is an
 * environment variable on purpose: a setting in `app_settings` could not be
 * read until the very migration it is meant to apply has run, and a column
 * added for it would be just as unreadable while the schema is behind.
 */
function isAutoApplyEnabled(env: Pick<CloudflareEnv, "AUTO_APPLY_MIGRATIONS">): boolean {
	const value = env.AUTO_APPLY_MIGRATIONS?.trim().toLowerCase();
	return value === "1" || value === "true";
}

/** The run found migrations to apply but a backup restore is running, so a later call tries again. */
const DEFERRED = "deferred";

/**
 * Applies every pending migration, taking the same safety backup the admin
 * "Apply now" button takes. Returns the names it applied, or null when there
 * was nothing to do (an empty database takes no backup, as in the admin route).
 */
async function autoApplyPendingMigrations(env: CloudflareEnv): Promise<string[] | null | typeof DEFERRED> {
	const status = await getMigrationStatus(env.DB);
	// Unknown migrations mean the database is ahead of this release: leave it alone.
	if (!status.pending.length || status.unknown.length) return null;
	// Never under a running restore, which validated against the schema as it is (the queue consumer calls this
	// for the restore's own messages too).
	if (await restoreBlocksMigrations(env.BUCKET)) return DEFERRED;
	if ((await listApplicationTables(env.DB)).size) await createSafetyBackup(env, "pre-migration");
	const result = await applyPendingMigrations(env.DB);
	console.info(JSON.stringify({ event: "migrations.auto_applied", applied: result.applied }));
	return result.applied;
}

/**
 * `AUTO_APPLY_MIGRATIONS=1` applies pending migrations as soon as the app
 * notices them; the mailbox banner's status check and the queue consumer call
 * this. The work happens at most once per isolate and concurrent callers share
 * the one attempt, so a burst of requests cannot start several runs. Two
 * isolates racing is safe: the shared runner records each migration in the same
 * batch that applies it and skips a name another isolate has already recorded.
 * A failed run is retried by the next caller and logged; the manual Apply
 * button stays the fallback.
 */
export function maybeAutoApplyPendingMigrations(env: CloudflareEnv): Promise<void> {
	if (!isAutoApplyEnabled(env)) return Promise.resolve();
	attempted ??= autoApplyPendingMigrations(env)
		.then((result) => {
			if (result === DEFERRED) attempted = null;
		})
		.catch((error) => {
			attempted = null;
			console.error("Automatic database migration failed", error);
		});
	return attempted;
}
