import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";

type CheckUser = (user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>) => Promise<Response | null>;

/**
 * The checks every change to one of the user's own import jobs makes: a session, Mail import allowed for the user
 * and a same-origin request. `run` gets the job id and the user and answers the request.
 */
export async function importJobMutation(
	request: Request,
	params: Promise<{ id: string }>,
	checkUser: CheckUser,
	run: (input: { env: CloudflareEnv; userId: string; jobId: string }) => Promise<Response>,
): Promise<Response> {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const denied = await checkUser(user);
	if (denied) return denied;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	return run({ env, userId: user.id, jobId: id });
}
