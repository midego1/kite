import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { LayoutPreferencesPendingError, readLayoutPreferences, saveLayoutPreferences } from "@/lib/preferences/layout";
import type { LayoutPreferencesResponse } from "@/lib/preferences/layout-types";
import { parseLayoutPatch } from "@/lib/preferences/layout-utils";

const NO_STORE = { "Cache-Control": "no-store" };

/** The signed-in account's layout, which every browser it uses loads; `ready` is false before migration 0080. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return NextResponse.json(await readLayoutPreferences(getDb(env), auth.user.id), { headers: NO_STORE });
}

/** Saves the choices in `{ layout }`, merged into what is stored; other choices stay as they were. */
export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	const patch = parseLayoutPatch(await request.json().catch(() => null));
	if (!patch) return NextResponse.json({ error: "Send at least one valid layout choice" }, { status: 400 });
	try {
		const layout = await saveLayoutPreferences(getDb(env), auth.user.id, patch);
		return NextResponse.json({ ready: true, layout } satisfies LayoutPreferencesResponse, { headers: NO_STORE });
	} catch (error) {
		if (!(error instanceof LayoutPreferencesPendingError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
}
