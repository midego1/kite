import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getEnv } from "@/lib/cloudflare";
import { telemetryForcedOff, telemetryUrl } from "@/lib/telemetry/telemetry-utils";
import type { SetupTelemetryStatus } from "@/lib/telemetry/types";
import { getPrimaryDomain } from "@/lib/user";

export async function GET() {
	const env = getEnv();
	try {
		const [adminAccountExists, domain] = await Promise.all([hasAdminAccount(env), getPrimaryDomain(env)]);
		// What the "Usage statistics" step explains, only until the first account exists.
		const telemetry: SetupTelemetryStatus | undefined = adminAccountExists
			? undefined
			: { forcedOff: telemetryForcedOff(env.KITE_TELEMETRY), endpoint: telemetryUrl(env.KITE_TELEMETRY_URL) };
		return NextResponse.json(
			{
				hasAdminAccount: adminAccountExists,
				setupTokenRequired: !adminAccountExists && (!!env.SETUP_TOKEN?.trim() || process.env.NODE_ENV === "production"),
				hasPrimaryDomain: !!domain,
				primaryDomain: domain ? { hostname: domain.hostname, sendingRequested: domain.sendingRequested } : null,
				...(telemetry ? { telemetry } : {}),
			},
			{
				headers: { "Cache-Control": "no-store" },
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not load setup status";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
