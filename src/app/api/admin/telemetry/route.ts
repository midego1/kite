import { getEnv } from "@/lib/cloudflare";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { getTelemetryStatus, setTelemetryEnabled, TelemetryUnavailableError } from "@/lib/telemetry/state";
import { TELEMETRY_AUDIT_ACTIONS, telemetryForcedOff } from "@/lib/telemetry/telemetry-utils";

const NO_STORE = { "Cache-Control": "no-store" };

/** Owner only: whether anonymous usage statistics are on, and where they would go. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return Response.json(await getTelemetryStatus(env), { headers: NO_STORE });
}

/** Owner only: `{ enabled }` turns statistics on (with a fresh install id) or off (deleting it). */
export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return Response.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE });
	const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
	if (typeof body?.enabled !== "boolean")
		return Response.json({ error: "Send enabled as true or false" }, { status: 400, headers: NO_STORE });
	if (body.enabled && telemetryForcedOff(env.KITE_TELEMETRY))
		return Response.json(
			{ error: "Usage statistics are turned off by the KITE_TELEMETRY setting of this deployment." },
			{ status: 409, headers: NO_STORE },
		);
	try {
		await setTelemetryEnabled(env, body.enabled);
	} catch (error) {
		if (!(error instanceof TelemetryUnavailableError)) throw error;
		return Response.json({ error: error.message }, { status: 409, headers: NO_STORE });
	}
	await createAuditLog(env, {
		actorUserId: auth.user.id,
		action: TELEMETRY_AUDIT_ACTIONS[body.enabled ? 0 : 1],
	});
	return Response.json(await getTelemetryStatus(env), { headers: NO_STORE });
}
