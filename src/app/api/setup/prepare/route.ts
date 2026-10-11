import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { requireSetupToken } from "@/lib/auth/setup-token";
import { getEnv } from "@/lib/cloudflare";
import { isNodeRuntime } from "@/lib/runtime";
import { runSetupRequirementChecks } from "@/lib/setup/configuration";
import { migrateCleanDatabase } from "@/lib/setup/migration";

export async function POST(request: Request) {
	const env = getEnv();
	if (await hasAdminAccount(env)) {
		return NextResponse.json({ error: "Initial setup is already complete" }, { status: 403 });
	}
	const tokenRejection = requireSetupToken(env, request);
	if (tokenRejection) return tokenRejection;

	const { checks, blocked } = await runSetupRequirementChecks(env, {
		// Behind a proxy the self-hosted server sees an internal address, so only Workers can suggest APP_URL.
		origin: isNodeRuntime(env) ? undefined : new URL(request.url).origin,
		production: process.env.NODE_ENV === "production",
	});
	if (blocked) {
		const failing = checks.find((check) => !check.configured && check.severity !== "recommended");
		return NextResponse.json(
			{ checks, migrated: false, error: failing ? `${failing.key}: ${failing.message}` : undefined },
			{ status: 503 },
		);
	}

	try {
		const migrated = await migrateCleanDatabase(env.DB);
		return NextResponse.json({ checks, migrated });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Database preparation failed";
		return NextResponse.json({ checks, migrated: false, error: message }, { status: 500 });
	}
}
