import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { estimateBackupObjects } from "@/lib/backups/objects";
import { getEnv } from "@/lib/cloudflare";

/** Owner only: about how many mail files, and how many bytes, a full backup would copy. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	try {
		return NextResponse.json(await estimateBackupObjects(env), { headers: { "Cache-Control": "no-store" } });
	} catch {
		return NextResponse.json({ error: "Could not estimate the size of the mail files" }, { status: 500 });
	}
}
