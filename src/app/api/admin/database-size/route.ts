import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";
import { getDatabaseSize, testDatabaseSize } from "@/lib/db/size";
import { databaseUseLevel } from "@/lib/db/size-utils";

/** Owner only: how big the database is against its limit. `size` is null when the binding reports none. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	const size = await getDatabaseSize(env, testDatabaseSize(env, request));
	return Response.json(
		{ size, level: size ? databaseUseLevel(size.usedBytes, size.limitBytes) : "ok" },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
