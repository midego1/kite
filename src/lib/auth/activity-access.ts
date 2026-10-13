import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";

/** The owner-only gate and the row limit that the Activity and audit-log reads share. */
export async function authorizeActivityRead(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { error: auth.error } as const;
	const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 100), 200);
	return { env, limit, error: null } as const;
}
