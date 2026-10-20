import { NextResponse } from "next/server";
import { requireSessionAdmin, requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import type { ModuleGuard } from "@/lib/modules/route-guard-types";
import type { DriveAnswer } from "./types";

type DriveAuth =
	{ env: CloudflareEnv; user: SessionUser; error: null } | { env: CloudflareEnv; user: null; error: Response };

const isMutation = (request: Request) => request.method !== "GET" && request.method !== "HEAD";

/**
 * Inside `withModule("drive", …)`: 401 without a session, 403 for a cross-site mutation, and 404 when the
 * user is restricted from Drive. With `admin`, 403 for anyone but an admin.
 */
export async function requireDriveUser(
	request: Request,
	guard: Pick<ModuleGuard, "checkUser">,
	options: { admin?: boolean } = {},
): Promise<DriveAuth> {
	const env = getEnv();
	const auth = options.admin ? await requireSessionAdmin(env, request) : await requireSessionUser(env, request);
	if (auth.error) return { env, user: null, error: auth.error };
	if (isMutation(request) && !hasValidSessionMutationOrigin(request))
		return { env, user: null, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	const denied = await guard.checkUser(auth.user);
	if (denied) return { env, user: null, error: denied };
	return { env, user: auth.user, error: null };
}

export const respond = (answer: DriveAnswer) => NextResponse.json(answer.body, { status: answer.status });

/** The request's JSON body; anything unreadable is null, which every Drive parser refuses with 400. */
export async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}
