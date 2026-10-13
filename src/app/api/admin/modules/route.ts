import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { loadModuleAdminView, setInstallModule } from "@/lib/modules/admin";
import { isModuleId } from "@/lib/modules/registry";

// The owner's view of every module: the stored switch, dependencies, what each adds and who is restricted.
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return NextResponse.json(await loadModuleAdminView(env));
}

/** Turns one module on or off for the install: `{ moduleId, enabled }`. Core areas have no switch. */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { moduleId?: unknown; enabled?: unknown } | null;
	if (!isModuleId(body?.moduleId))
		return NextResponse.json({ error: "Unknown module", code: "UNKNOWN_MODULE" }, { status: 400 });
	if (typeof body.enabled !== "boolean")
		return NextResponse.json({ error: "enabled must be true or false", code: "INVALID_BODY" }, { status: 400 });
	const result = await setInstallModule(env, auth.user, { moduleId: body.moduleId, enabled: body.enabled });
	if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
	return NextResponse.json(await loadModuleAdminView(env));
}
