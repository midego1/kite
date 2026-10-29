import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { restoreStoredBackup } from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		const { id } = await params;
		const outcome = await restoreStoredBackup(env, id, auth.user.id);
		if (!outcome) return NextResponse.json({ error: "Completed backup not found" }, { status: 404 });
		return NextResponse.json({ ok: true, safetyBackupId: outcome.safetyBackupId, rowCount: outcome.rowCount });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
