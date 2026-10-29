import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { startBackupObjectsRestore } from "@/lib/backups/objects";
import { getEnv } from "@/lib/cloudflare";

/** Owner only: puts the mail files of a full backup back, on the queue; files that exist are left alone. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		const { id } = await params;
		if (!(await startBackupObjectsRestore(env, id)))
			return NextResponse.json({ error: "This backup has no copied mail files" }, { status: 404 });
		return NextResponse.json({ ok: true, status: "restoring" }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore the mail files";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
