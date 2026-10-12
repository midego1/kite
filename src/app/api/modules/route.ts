import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { listCapabilities } from "@/lib/modules/capability-registry";
import { isModuleEnabled } from "@/lib/modules/invoke";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";

// The modules the signed-in user has on and the tools they declare. Descriptors are
// JSON-only, the same data a remote client would receive from the MCP tool list.
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const viewer = { userId: auth.user.id, role: auth.user.role, isPrimaryAdmin: auth.user.isPrimaryAdmin };
	const enabled = [];
	for (const manifest of MODULE_MANIFESTS) {
		if (await isModuleEnabled(viewer, manifest.id)) enabled.push(manifest);
	}
	return NextResponse.json({
		modules: enabled.map(({ id, name, description, nav }) => ({ id, name, description, nav })),
		tools: listCapabilities(
			"assistant_tool",
			enabled.map((manifest) => manifest.id),
		).map(({ moduleId, descriptor }) => ({ moduleId, ...descriptor })),
	});
}
