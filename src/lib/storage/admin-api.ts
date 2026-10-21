import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import type { Failure } from "./stores";

const noStore = { "Cache-Control": "no-store" };

type Access = { env: CloudflareEnv; actor: { id: string }; origin: string; error: null } | { error: Response };

/**
 * Storage settings belong to the primary administrator alone, like the AWS credentials. Mutations also need a
 * same-origin request. `origin` is the browser's own origin, which the CORS checks test uploads from.
 */
export async function authorizeStorage(request: Request, mutation: boolean): Promise<Access> {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { error: auth.error };
	if (mutation && !hasValidSessionMutationOrigin(request))
		return { error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	const origin = request.headers.get("origin") || new URL(request.url).origin;
	return { env, actor: { id: auth.user.id }, origin, error: null };
}

export function storageJson(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: noStore });
}

/** A service result as a response: failures carry their status and, after a check, the step report. */
export function storageResult<T extends object>(result: ({ ok: true } & T) | Failure): Response {
	if (result.ok) {
		const { ok: _ok, ...body } = result;
		return storageJson(body);
	}
	const { ok: _ok, status, ...body } = result;
	return storageJson(body, status);
}

export async function readBody(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}
