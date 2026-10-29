import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { restoreUploadedBackup } from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";

/**
 * The backup file is the raw request body (the Backups page sends it that way, so it is streamed to storage rather
 * than buffered); a multipart form with a `backup` file field is still accepted.
 */
async function uploadedBody(request: Request): Promise<ReadableStream<Uint8Array> | null> {
	if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return request.body;
	const file = (await request.formData()).get("backup");
	return file instanceof File ? file.stream() : null;
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	const { user } = auth;
	try {
		const body = await uploadedBody(request);
		if (!body) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		const outcome = await restoreUploadedBackup(env, body, user.id);
		return NextResponse.json({ ok: true, safetyBackupId: outcome.safetyBackupId, rowCount: outcome.rowCount });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
