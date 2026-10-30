import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { retryBackupObjectsCopy } from "@/lib/backups/objects";
import { getEnv } from "@/lib/cloudflare";

/**
 * Owner only: copies the mail files of a backup again after the copy failed (from where it stopped) or finished with
 * files it could not copy (from the start, skipping files already copied).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		const { id } = await params;
		if (!(await retryBackupObjectsCopy(env, id)))
			return NextResponse.json({ error: "There is no failed copy of mail files to retry" }, { status: 409 });
		return NextResponse.json({ ok: true, status: "copying" }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to retry copying the mail files";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
