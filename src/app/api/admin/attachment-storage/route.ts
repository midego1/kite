import { requireSessionAdmin } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getAttachmentStorageCounts, verifyAttachmentObjects } from "@/lib/email/attachment-storage-report";

/**
 * Admins: how attachments are stored (`docs/specs/attachments-once.md` §5.5). With `?verify=1` it also looks up the
 * newest 200 referenced objects and lists the missing ones by key and message id, never content.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	const verify = new URL(request.url).searchParams.get("verify") === "1";
	const [counts, verification] = await Promise.all([
		getAttachmentStorageCounts(env),
		verify ? verifyAttachmentObjects(env) : null,
	]);
	return Response.json(
		{ ...counts, ...(verification ? { verify: verification } : {}) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
