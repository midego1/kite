import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { pauseImportJob } from "@/lib/import/jobs";
import { withModule } from "@/lib/modules/route-guard";

type Params = { params: Promise<{ id: string }> };

/**
 * Pauses a waiting or running import (spec §4.5). It keeps its saved password and its place, and a batch that is
 * running finishes first; `POST …/resume` continues it.
 */
export const POST = withModule<Params>("import", async (request, { params, checkUser }) => {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	if (!(await pauseImportJob(env, user.id, id))) {
		return Response.json({ error: "Import job not found or not running" }, { status: 404 });
	}
	return Response.json({ ok: true });
});
