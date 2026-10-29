import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { failStaleBackups, getBackupHealth } from "@/lib/backups/service";
import { getEnv } from "@/lib/cloudflare";

/** Owner only: the latest successful backup, its size and duration, and whether the latest run failed. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		// Like the Backups page, an interrupted run counts as the failure it is rather than "in progress" forever.
		await failStaleBackups(env);
		return NextResponse.json(await getBackupHealth(env), { headers: { "Cache-Control": "no-store" } });
	} catch {
		return NextResponse.json({ error: "Could not read the backups" }, { status: 500 });
	}
}
