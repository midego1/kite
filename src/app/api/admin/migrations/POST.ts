import { NextResponse } from "next/server";
import { listApplicationTables } from "@/lib/backups/export";
import { createSafetyBackup } from "@/lib/backups/safety";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import type { MigrationApplyResponse } from "./types";
import { authorizeMigrationRequest } from "./utils";

export async function POST(request: Request) {
	const authorization = await authorizeMigrationRequest(request);
	if ("error" in authorization) return authorization.error;
	const { env } = authorization;

	let backupId: string | null = null;
	try {
		const status = await getMigrationStatus(env.DB);
		if (status.pending.length && !status.unknown.length && (await listApplicationTables(env.DB)).size > 0) {
			backupId = (await createSafetyBackup(env, "pre-migration")).id;
		}
	} catch (error) {
		return NextResponse.json(
			{
				error: `Could not back up the database before migrating, so nothing was changed: ${error instanceof Error ? error.message : "Backup failed"}`,
			},
			{ status: 500 },
		);
	}

	try {
		return NextResponse.json({ ...(await applyPendingMigrations(env.DB)), backupId } satisfies MigrationApplyResponse);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not apply database migrations";
		return NextResponse.json(
			{ error: backupId ? `${message} A backup taken just before is listed on the Backups page.` : message, backupId },
			{ status: 500 },
		);
	}
}
