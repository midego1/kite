import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import {
	getAttachmentStorageCounts,
	getReclaimCounts,
	getSharedObjectCounts,
	verifyAttachmentObjects,
} from "@/lib/email/attachment-storage-report";
import {
	AttachmentJobsUnavailableError,
	cancelAttachmentJob,
	getAttachmentJobStatus,
	startAttachmentJob,
} from "@/lib/email/attachment-storage-jobs";
import { isAttachmentStorageDirection } from "@/lib/email/attachment-storage-jobs-utils";

const noStore = { "Cache-Control": "no-store" };

/**
 * Admins: how attachments are stored (`docs/specs/attachments-once.md` §5.5): rows with an object, rows served from
 * their raw message, objects several rows share, what reclaim has still to look at, and the storage job with the
 * switches that decide what may run. With `?verify=1` it also looks up the newest 200 referenced objects and lists the
 * missing ones by key and message id, never content.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	const verify = new URL(request.url).searchParams.get("verify") === "1";
	const [counts, shared, reclaim, status, verification] = await Promise.all([
		getAttachmentStorageCounts(env),
		getSharedObjectCounts(env),
		getReclaimCounts(env),
		getAttachmentJobStatus(env),
		verify ? verifyAttachmentObjects(env) : null,
	]);
	return Response.json(
		{ ...counts, shared, reclaim, ...status, ...(verification ? { verify: verification } : {}) },
		{ headers: noStore },
	);
}

/**
 * The primary admin: `{ action: "reclaim" | "materialize" }` starts that job (or resumes it from where it stopped),
 * `{ action: "cancel" }` stops the running one after its current batch. Each writes an audit row.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return Response.json({ error: "Invalid origin" }, { status: 403, headers: noStore });
	const body = ((await request.json().catch(() => null)) ?? {}) as { action?: unknown; testCrashAfter?: unknown };
	const actor = { id: auth.user.id };
	try {
		const answer =
			body.action === "cancel"
				? await cancelAttachmentJob(env, actor)
				: isAttachmentStorageDirection(body.action)
					? await startAttachmentJob(env, actor, {
							direction: body.action,
							testCrashAfter: typeof body.testCrashAfter === "number" ? body.testCrashAfter : undefined,
						})
					: null;
		if (!answer)
			return Response.json(
				{ error: 'action must be "reclaim", "materialize" or "cancel"' },
				{ status: 400, headers: noStore },
			);
		if (!answer.ok)
			return Response.json({ error: answer.error, code: answer.code }, { status: answer.status, headers: noStore });
		return Response.json({ job: answer.job }, { headers: noStore });
	} catch (error) {
		if (!(error instanceof AttachmentJobsUnavailableError)) throw error;
		return Response.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409, headers: noStore });
	}
}
