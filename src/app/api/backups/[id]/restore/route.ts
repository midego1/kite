import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { RestoreBusyError, RestoreRecoveryPendingError, startStoredRestore } from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";

/** Queues a restore of a completed backup from storage; the Backups page follows it through /api/backups/health. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try {
		const { id } = await params;
		const job = await startStoredRestore(env, id, auth.user.id);
		if (!job) return NextResponse.json({ error: "Completed backup not found" }, { status: 404 });
		return NextResponse.json({ ok: true, restoreId: job.id }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		const conflict = error instanceof RestoreBusyError || error instanceof RestoreRecoveryPendingError;
		return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
	}
}
