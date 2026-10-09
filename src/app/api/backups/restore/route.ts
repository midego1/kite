import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { restoreDatabaseBackup } from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	const { user } = auth;
	try {
		const form = await request.formData();
		const file = form.get("backup");
		if (!(file instanceof File)) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		const outcome = await restoreDatabaseBackup(env, await file.arrayBuffer(), user.id);
		return NextResponse.json({ ok: true, safetyBackupId: outcome.safetyBackupId });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
