import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getDeploymentVersion } from "@/lib/deployment-version";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The deployment this server runs, for the "Kite was updated" toast. Only
 * signed-in users may read it, so the deployment id is not public. It is never
 * compared with anything outside the install.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) {
		auth.error.headers.set("Cache-Control", "no-store");
		return auth.error;
	}
	return Response.json({ version: getDeploymentVersion(env) }, { headers: NO_STORE });
}
