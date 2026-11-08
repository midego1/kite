import { drizzle } from "drizzle-orm/d1";
import * as coreTables from "@/db/schema";
import * as assistantEmailTables from "@/db/schema/assistant-email";
import * as autoReadTables from "@/db/schema/agent-auto-read";
import * as backupTables from "@/db/schema/backups";
import * as agentProviderTables from "@/db/schema/agent-providers";
import * as summaryTables from "@/db/schema/agent-summaries";
import * as writingTables from "@/db/schema/agent-writing";
import * as spamReportTables from "@/db/schema/spam-reports";
import * as driveTables from "@/db/schema/drive";
import {
	externalAccountAuthRechecks,
	externalAccountFolders,
	externalAccounts,
	externalIdentities,
	externalMessageRefs,
	externalProviderActions,
	externalTwoWayState,
} from "@/db/schema/external-accounts";
import * as financeTables from "@/db/schema/finance";
import * as moduleTables from "@/db/schema/modules";
import * as screenerTables from "@/db/schema/screener";
import * as storageTables from "@/db/schema/storage";
import * as telemetryTables from "@/db/schema/telemetry";
import * as userPreferenceTables from "@/db/schema/user-preferences";

// `driveItemColdView` is a narrow view of `driveItems` (same underlying `drive_items` table, fewer columns),
// kept out of the merged schema like the other narrow views (`message-bodies.ts`, `spam-policy.ts`): two
// Drizzle table objects for one SQL table would confuse `drizzle-kit generate` and the relational query builder.
const { driveItemColdView: _driveItemColdView, ...driveSchemaTables } = driveTables;

const schema = {
	...coreTables,
	...assistantEmailTables,
	...autoReadTables,
	...backupTables,
	...agentProviderTables,
	...writingTables,
	...summaryTables,
	...spamReportTables,
	...moduleTables,
	...financeTables,
	...driveSchemaTables,
	...storageTables,
	...screenerTables,
	...telemetryTables,
	externalAccounts,
	externalAccountAuthRechecks,
	externalAccountFolders,
	externalIdentities,
	externalMessageRefs,
	externalProviderActions,
	externalTwoWayState,
	...userPreferenceTables,
};

export type AppDatabase = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export function getDb(env: Pick<CloudflareEnv, "DB">) {
	if (!env.DB) {
		throw new Error("No database binding configured");
	}
	return createDb(env.DB);
}

export { schema };
