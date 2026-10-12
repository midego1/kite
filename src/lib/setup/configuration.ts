import { cfRequest } from "@/lib/cloudflare-api";
import { CloudflareApiError } from "@/lib/cloudflare-api-error";
import { hasCloudflareCredentials, isNodeRuntime } from "@/lib/runtime";
import {
	checkAppUrl,
	checkCloudflareTokenResult,
	checkEncryptionKey,
	checkWorkerName,
	hasBlockingFailure,
} from "./configuration-utils";
import type { CloudflareTokenOutcome, SetupRequirementCheck } from "./types";

type SetupCheckContext = {
	/** Address this request was served from; lets the checks suggest the exact APP_URL. */
	origin?: string;
	production?: boolean;
};

function getSetupRequirementChecks(env: CloudflareEnv, context: SetupCheckContext = {}): SetupRequirementCheck[] {
	const hasApiToken = !!env.CF_TOKEN?.trim();
	const hasGlobalKey = !!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim();
	const production = context.production ?? false;
	const advice = [checkEncryptionKey({ env, production }), checkAppUrl({ env, origin: context.origin })];

	if (isNodeRuntime(env)) {
		const mailer = env.EMAIL as unknown as { configured?: boolean };
		return [
			{
				key: "Database",
				configured: !!env.DB,
				message: "DATA_DIR must be writable; the SQLite database is created there on start.",
			},
			{
				key: "Outbound mail",
				configured: mailer?.configured === true,
				message: "Set SMTP_URL, or CF_ACCOUNT_ID with CF_TOKEN to send through Cloudflare. Receiving works without it.",
			},
			{
				key: "Cloudflare API credentials (optional)",
				configured: true,
				message: hasCloudflareCredentials(env)
					? "Domains are provisioned on Cloudflare automatically."
					: "Not set: add MX and SPF records for each domain by hand, as shown on the domain page.",
			},
			...advice,
		];
	}

	const workerName = checkWorkerName({ origin: context.origin });
	return [
		{
			key: "Cloudflare API credentials",
			configured: hasApiToken || hasGlobalKey,
			message:
				"Set CF_TOKEN (an Account API token with DNS: Edit, Zone: Read, Zone Settings: Edit and Email Routing Rules: Edit), or set both CF_API_KEY and CF_EMAIL. See docs/deployment.md, step 1.",
		},
		{
			key: "D1 database",
			configured: !!env.DB,
			message: "Deploy the Worker with the DB binding from wrangler.jsonc.",
		},
		...(workerName ? [workerName] : []),
		...advice,
	];
}

/** Asks Cloudflare for one zone, which proves the token is accepted and can read zones. */
async function verifyCloudflareToken(env: CloudflareEnv): Promise<CloudflareTokenOutcome> {
	try {
		const zones = await cfRequest<Array<{ id: string }>>(env, "/zones?per_page=1");
		return zones.length > 0 ? { kind: "ok" } : { kind: "no_zones" };
	} catch (error) {
		if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
			return { kind: "rejected", detail: error.message };
		}
		return { kind: "unreachable", detail: error instanceof Error ? error.message : "request failed" };
	}
}

/**
 * Static configuration checks plus, once those pass and credentials exist, one live call to
 * Cloudflare so a bad or under-scoped CF_TOKEN is reported here instead of halfway through the
 * domain step.
 */
export async function runSetupRequirementChecks(
	env: CloudflareEnv,
	context: SetupCheckContext = {},
): Promise<{ checks: SetupRequirementCheck[]; blocked: boolean }> {
	const checks = getSetupRequirementChecks(env, context);
	if (!hasBlockingFailure(checks) && hasCloudflareCredentials(env)) {
		const result = checkCloudflareTokenResult(await verifyCloudflareToken(env));
		// A self-hosted install may hold a token that only sends mail, which cannot list zones.
		checks.push(isNodeRuntime(env) && result.severity === "required" ? { ...result, severity: "recommended" } : result);
	}
	return { checks, blocked: hasBlockingFailure(checks) };
}
