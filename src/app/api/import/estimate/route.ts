import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { testDatabaseSize } from "@/lib/db/size";
import { estimateImportForInstall } from "@/lib/import/size-guard";
import { withModule } from "@/lib/modules/route-guard";

type EstimateRequest = { messages?: number | null; rawBytes?: number | null };

function count(value: unknown): number | null {
	const number = Number(value);
	return value === null || value === undefined || !Number.isFinite(number) || number < 0 ? null : Math.floor(number);
}

/**
 * What an import of `messages` messages (`rawBytes` of source mail, both optional) adds to the database, with the
 * database's current size. `estimate` is null when the size cannot be read.
 */
export const POST = withModule("import", async (request, { checkUser }) => {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	const body = await readJsonBody<EstimateRequest>(request, 1024).catch(() => ({}) as EstimateRequest);
	const estimate = await estimateImportForInstall(
		env,
		{ messages: count(body.messages), rawBytes: count(body.rawBytes) },
		testDatabaseSize(request),
	);
	return Response.json({ estimate }, { headers: { "Cache-Control": "no-store" } });
});
