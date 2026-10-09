import { cfRequest, listEmailRoutingRules } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";
import { getCloudflareAuth, getEmailWorkerName, LEGACY_EMAIL_WORKER_NAMES } from "@/lib/cloudflare-api-utils";
import { getEmailRoutingCatchAll } from "@/lib/domains/catch-all-routing";
import { repointRule, routesToWorker, ruleAddress } from "./routing-utils";
import type { LegacyRoute, LegacyRoutingResult, LegacyRoutingStatus } from "./types";

type ZoneRules = { zoneId: string; hostname: string; rules: CfEmailRoutingRule[]; catchAll: CfEmailRoutingRule | null };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listZones(env: CloudflareEnv): Promise<Map<string, string>> {
	const { results } = await env.DB.prepare(
		"SELECT hostname, zone_id FROM domains WHERE zone_id <> 'manual' ORDER BY hostname",
	).all<{ hostname: string; zone_id: string }>();
	const zones = new Map<string, string>();
	for (const row of results) if (row.zone_id && !zones.has(row.zone_id)) zones.set(row.zone_id, row.hostname);
	return zones;
}

/** Email Routing rules and catch-alls on this install's zones that still deliver to a legacy Worker. */
async function findLegacyRules(env: CloudflareEnv): Promise<{ zones: ZoneRules[]; problems: string[] }> {
	const zones: ZoneRules[] = [];
	const problems: string[] = [];
	for (const [zoneId, hostname] of await listZones(env)) {
		try {
			const rules = (await listEmailRoutingRules(env, zoneId)).filter(
				(rule) => ruleAddress(rule) !== "*" && routesToWorker(rule, LEGACY_EMAIL_WORKER_NAMES),
			);
			const catchAll = await getEmailRoutingCatchAll(env, zoneId);
			zones.push({
				zoneId,
				hostname,
				rules,
				catchAll: catchAll && routesToWorker(catchAll, LEGACY_EMAIL_WORKER_NAMES) ? catchAll : null,
			});
		} catch (error) {
			problems.push(`${hostname}: ${describe(error)}`);
		}
	}
	return { zones, problems };
}

function toRoutes(zone: ZoneRules): LegacyRoute[] {
	const routes = zone.rules.map((rule) => ({
		zoneId: zone.zoneId,
		hostname: zone.hostname,
		ruleId: rule.id ?? null,
		address: ruleAddress(rule),
	}));
	if (zone.catchAll) routes.push({ zoneId: zone.zoneId, hostname: zone.hostname, ruleId: null, address: "*" });
	return routes;
}

export async function getLegacyRoutingStatus(env: CloudflareEnv): Promise<LegacyRoutingStatus> {
	const workerName = getEmailWorkerName();
	try {
		getCloudflareAuth(env);
	} catch (error) {
		return { configured: false, error: describe(error), workerName, routes: [] };
	}
	const { zones, problems } = await findLegacyRules(env);
	return {
		configured: true,
		workerName,
		routes: zones.flatMap(toRoutes),
		...(problems.length ? { error: problems.join("; ") } : {}),
	};
}

/** Points every rule found by getLegacyRoutingStatus at this Worker; rules that fail are reported, not retried. */
export async function repointLegacyRoutes(env: CloudflareEnv): Promise<LegacyRoutingResult> {
	getCloudflareAuth(env);
	const workerName = getEmailWorkerName();
	const result: LegacyRoutingResult = { updated: 0, failed: [] };
	const { zones } = await findLegacyRules(env);
	for (const zone of zones) {
		const targets = [
			...zone.rules.filter((rule) => rule.id).map((rule) => ({ rule, path: `rules/${rule.id}` })),
			...(zone.catchAll ? [{ rule: zone.catchAll, path: "rules/catch_all" }] : []),
		];
		for (const { rule, path } of targets) {
			const body = repointRule(rule, workerName, LEGACY_EMAIL_WORKER_NAMES);
			// The catch-all has a fixed place after every other rule and takes no priority.
			if (path === "rules/catch_all") delete body.priority;
			try {
				await cfRequest<CfEmailRoutingRule>(env, `/zones/${zone.zoneId}/email/routing/${path}`, {
					method: "PUT",
					body: JSON.stringify(body),
				});
				result.updated += 1;
			} catch (error) {
				result.failed.push({
					route: { zoneId: zone.zoneId, hostname: zone.hostname, ruleId: rule.id ?? null, address: ruleAddress(rule) },
					error: describe(error),
				});
			}
		}
	}
	return result;
}
