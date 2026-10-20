import { NextResponse } from "next/server";
import { requireSessionAdmin, requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { answerDrive } from "./errors";
import type { DriveAnswer } from "./types";

type DriveAuth =
	{ env: CloudflareEnv; user: SessionUser; error: null } | { env: CloudflareEnv; user: null; error: Response };

const isMutation = (request: Request) => request.method !== "GET" && request.method !== "HEAD";

/**
 * The caller of a Drive route: 401 without a session, 403 for a cross-site mutation and, with `admin`,
 * 403 for anyone but an admin. Routes wrap it in the module guard's `checkAuth`, which answers 404 when
 * the user is restricted from Drive.
 */
export async function requireDriveUser(request: Request, options: { admin?: boolean } = {}): Promise<DriveAuth> {
	const env = getEnv();
	const auth = options.admin ? await requireSessionAdmin(env, request) : await requireSessionUser(env, request);
	if (auth.error) return { env, user: null, error: auth.error };
	if (isMutation(request) && !hasValidSessionMutationOrigin(request))
		return { env, user: null, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, user: auth.user, error: null };
}

const respond = (answer: DriveAnswer) => NextResponse.json(answer.body, { status: answer.status });

/** Runs a Drive operation (see `answerDrive`) and answers with its JSON. */
export async function driveJson(
	env: CloudflareEnv,
	run: () => Promise<DriveAnswer>,
	whenPending?: Record<string, unknown>,
): Promise<Response> {
	return respond(await answerDrive(env, run, whenPending));
}

/** The request's JSON body; anything unreadable is null, which every Drive parser refuses with 400. */
export async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}

/** Where links point: APP_URL when it is set, so links made behind a proxy still open from outside. */
export function appOrigin(env: CloudflareEnv, request: Request): string {
	const configured = env.APP_URL?.trim();
	if (configured) {
		try {
			return new URL(configured).origin;
		} catch {
			// An unusable APP_URL falls back to the request's own origin.
		}
	}
	return new URL(request.url).origin;
}
