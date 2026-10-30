import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { ExternalAccountRefusal, MIGRATION_PENDING_CODE } from "./errors";

/**
 * Runs a connected-accounts request and turns refusals into JSON answers. A table missing before migration 0079 is a
 * 409 `MIGRATION_PENDING` for writes; reads pass `whenPending`, the body they answer instead. Other errors are logged
 * by name only (a database error's message carries the SQL) and answered plainly.
 */
export async function answerExternal(
	run: () => Promise<Record<string, unknown>>,
	options: { status?: number; whenPending?: Record<string, unknown> } = {},
): Promise<Response> {
	try {
		return NextResponse.json(await run(), { status: options.status ?? 200, headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof ExternalAccountRefusal)
			return NextResponse.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, {
				status: error.status,
			});
		if (isNoSuchTableError(error)) {
			if (options.whenPending) return NextResponse.json({ ...options.whenPending, migrationPending: true });
			return NextResponse.json(
				{ error: "Apply the pending database update to use connected accounts", code: MIGRATION_PENDING_CODE },
				{ status: 409 },
			);
		}
		console.error("external.request_failed", error instanceof Error ? error.name : "unknown");
		return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
	}
}

/**
 * A POST on one of the signed-in user's accounts (`/api/external-accounts/[id]/…`): the session and the request's
 * origin first, then `run` with the account id, answered through `answerExternal`.
 */
export async function postOnAccount(
	request: Request,
	params: Promise<{ id: string }>,
	run: (env: CloudflareEnv, user: SessionUser, id: string) => Promise<Record<string, unknown>>,
	options: { status?: number } = {},
): Promise<Response> {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	return answerExternal(() => run(env, auth.user, id), options);
}
