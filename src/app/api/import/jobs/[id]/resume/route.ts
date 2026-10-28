import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { resumeImportJob } from "@/lib/import/jobs";
import { testDatabaseSize } from "@/lib/db/size";
import { withModule } from "@/lib/modules/route-guard";

type Params = { params: Promise<{ id: string }> };

/**
 * Resumes an import that paused itself. While the database is above 90% of its limit it answers 409
 * `DATABASE_NEARLY_FULL` until the body says `{ "confirmDatabaseFull": true }`.
 */
export const POST = withModule<Params>("import", async (request, { params, checkUser }) => {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<{ confirmDatabaseFull?: boolean }>(request, 1024).catch(() => ({}));
	const { id } = await params;
	const outcome = await resumeImportJob(env, user.id, id, {
		confirmed: (body as { confirmDatabaseFull?: boolean }).confirmDatabaseFull === true,
		sizeOverride: testDatabaseSize(request),
	});
	if (outcome === "not_found") return Response.json({ error: "Paused import not found" }, { status: 404 });
	if (outcome === "needs_confirmation") {
		return Response.json(
			{
				error: "The database is above 90% of its size limit. Confirm to resume the import anyway.",
				code: "DATABASE_NEARLY_FULL",
			},
			{ status: 409 },
		);
	}
	return Response.json({ ok: true });
});
