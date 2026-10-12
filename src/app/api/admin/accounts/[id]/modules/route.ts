import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { loadUserModuleAccess, setUserModuleAccess } from "@/lib/modules/admin";
import type { ModuleId } from "@/lib/modules/module-types";
import { isModuleId } from "@/lib/modules/registry";

type Params = { params: Promise<{ id: string }> };
type Change = { moduleId: ModuleId; allowed: boolean };

/** `{ moduleId, allowed }` for one module, or `{ access: { <moduleId>: boolean } }` for several. */
function parseChanges(body: unknown): Change[] | null {
	if (!body || typeof body !== "object") return null;
	const { moduleId, allowed, access } = body as { moduleId?: unknown; allowed?: unknown; access?: unknown };
	if (moduleId !== undefined) {
		return isModuleId(moduleId) && typeof allowed === "boolean" ? [{ moduleId, allowed }] : null;
	}
	if (!access || typeof access !== "object" || Array.isArray(access)) return null;
	const entries = Object.entries(access);
	if (!entries.length) return null;
	const changes: Change[] = [];
	for (const [id, value] of entries) {
		if (!isModuleId(id) || typeof value !== "boolean") return null;
		changes.push({ moduleId: id, allowed: value });
	}
	return changes;
}

// Per-user module access is the owner's alone.
export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	const { id } = await params;
	return NextResponse.json(await loadUserModuleAccess(env, id));
}

export async function PUT(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const changes = parseChanges(await request.json().catch(() => null));
	if (!changes)
		return NextResponse.json(
			{ error: "Send a known moduleId with allowed, or an access map of module ids", code: "INVALID_BODY" },
			{ status: 400 },
		);
	const { id } = await params;
	const result = await setUserModuleAccess(env, auth.user, id, changes);
	if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
	return NextResponse.json(await loadUserModuleAccess(env, id));
}
