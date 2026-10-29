import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { RestoreBusyError, startSafetyRecovery } from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";

/**
 * Owner only: restores the safety backup of a restore that was interrupted and could not be rolled back (the
 * admin overview's "Restore previous data" button).
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try {
		const job = await startSafetyRecovery(env, auth.user.id);
		if (!job) return NextResponse.json({ error: "No restore needs recovery" }, { status: 404 });
		return NextResponse.json({ ok: true, restoreId: job.id }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: error instanceof RestoreBusyError ? 409 : 400 });
	}
}
