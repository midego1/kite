import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import {
	NODE_BACKUP_UPLOAD_MAX_BYTES,
	RestoreBusyError,
	RestoreRecoveryPendingError,
	RestoreUploadTooLargeError,
	startUploadedRestore,
} from "@/lib/backups/restore";
import { getEnv } from "@/lib/cloudflare";
import { isNodeRuntime } from "@/lib/runtime";

/**
 * The backup file is the raw request body (the Backups page sends it that way, so it is streamed to storage rather
 * than buffered); a multipart form with a `backup` file field is still accepted.
 */
async function uploadedBody(request: Request): Promise<ReadableStream<Uint8Array> | null> {
	if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return request.body;
	const file = (await request.formData()).get("backup");
	return file instanceof File ? file.stream() : null;
}

function errorStatus(error: unknown): number {
	if (error instanceof RestoreBusyError || error instanceof RestoreRecoveryPendingError) return 409;
	if (error instanceof RestoreUploadTooLargeError) return 413;
	return 400;
}

/**
 * Stores the uploaded file and queues its restore; the Backups page follows it through /api/backups/health. On
 * Workers the platform's request body limit caps the upload; the self-hosted server caps it itself.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const maxBytes = isNodeRuntime(env) ? NODE_BACKUP_UPLOAD_MAX_BYTES : Number.POSITIVE_INFINITY;
	try {
		if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new RestoreUploadTooLargeError(maxBytes);
		const body = await uploadedBody(request);
		if (!body) return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		const job = await startUploadedRestore(env, body, auth.user.id, maxBytes);
		return NextResponse.json({ ok: true, restoreId: job.id }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: errorStatus(error) });
	}
}
