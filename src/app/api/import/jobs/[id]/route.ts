import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { cancelImportJob } from "@/lib/import/jobs";

type Params = { params: Promise<{ id: string }> };

/** Cancels a pending or running import. Messages already imported stay. */
export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	if (!(await cancelImportJob(env, user.id, id))) {
		return Response.json({ error: "Import job not found or already finished" }, { status: 404 });
	}
	return Response.json({ ok: true });
}
