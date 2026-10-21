import { createLogger } from "../../src/lib/logger.mjs";

import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { failStaleBackups } from "@/lib/backups/service";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { runTrashRetention } from "@/lib/email/trash-retention";
import { runDatabasePruning } from "@/lib/maintenance/pruning";
import { runOperationalAlerts } from "@/lib/alerts/run";
import { runModuleCronTasks } from "@/lib/modules/background";
import { runStorageMigrationMaintenance } from "@/lib/storage/migration";

const logger = createLogger("node-scheduler");

/** Fire the daily 02:00 UTC backup and pruning, the 5-minute operational alerts and the recurring maintenance jobs, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	let lastAlertMinute = 0;
	const timer = setInterval(() => {
		runAgentMaintenance(env).catch((error) => logger.error("agent.maintenance_failed", { error }));
		runTrashRetention(env).catch((error) => logger.error("trash.retention_failed", { error }));
		const now = new Date();
		if (now.getUTCMinutes() % 5 === 0 && lastAlertMinute !== now.getTime() - (now.getTime() % 60_000)) {
			lastAlertMinute = now.getTime() - (now.getTime() % 60_000);
			// Recover interrupted backups before evaluating alerts, matching worker.ts.
			failStaleBackups(env, now)
				.then((count) => {
					if (count) logger.warn("backup.stale_marked_failed", { count });
				})
				.catch((error) => logger.error("backup.stale_recover_failed", { error }))
				.then(() => runOperationalAlerts(env, now))
				.catch((error) => logger.error("alerts.evaluation_failed", { error }));
			runModuleCronTasks(env, "*/5 * * * *", now).catch((error) => logger.error("modules.cron_failed", { error }));
			runStorageMigrationMaintenance(env, now).catch((error) =>
				logger.error("storage.migration_maintenance_failed", { error }),
			);
		}
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now)
			.catch((error) => logger.error("backup.scheduled_failed", { error }))
			.then(() => runDatabasePruning(env, now))
			.catch((error) => logger.error("database.pruning_failed", { error }));
		runModuleCronTasks(env, "0 2 * * *", now).catch((error) => logger.error("modules.cron_failed", { error }));
	}, 60_000);
	return () => clearInterval(timer);
}
