import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { isModuleId } from "@/lib/modules/registry";
import { setModuleEnabled, setUserModuleAllowed } from "@/lib/modules/state";

type Body = {
	modules?: Record<string, unknown>;
	access?: { userId?: unknown; moduleId?: unknown; allowed?: unknown }[];
};

// End-to-end specs set module state here until they can use the admin API. Like /api/seed it answers
// nothing in production builds, and it also needs the owner's session.
export async function PUT(request: Request) {
	if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as Body | null;
	const updatedBy = auth.user.id;
	for (const [moduleId, enabled] of Object.entries(body?.modules ?? {})) {
		if (!isModuleId(moduleId) || typeof enabled !== "boolean")
			return NextResponse.json({ error: `Invalid module ${moduleId}` }, { status: 400 });
		await setModuleEnabled(env, { moduleId, enabled, updatedBy });
	}
	for (const row of body?.access ?? []) {
		if (typeof row.userId !== "string" || !isModuleId(row.moduleId) || typeof row.allowed !== "boolean")
			return NextResponse.json({ error: "Invalid access row" }, { status: 400 });
		await setUserModuleAllowed(env, { userId: row.userId, moduleId: row.moduleId, allowed: row.allowed, updatedBy });
	}
	return NextResponse.json({ ok: true });
}
