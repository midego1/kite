import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { findZoneByHostname } from "@/lib/cloudflare-api";
import type { DomainRow } from "@/lib/domains/types";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { shouldAdoptZone, ZoneAdoptionError } from "./skip-dns-utils";

/**
 * A domain added with DNS skipped keeps the "manual" zone, which every Cloudflare call
 * ignores. The first Cloudflare DNS setup, Cloudflare sending or Cloudflare receiving
 * setup looks up the real zone and records it so that setup can run. Returns the row
 * unchanged when there is nothing to adopt (see `shouldAdoptZone`).
 */
export async function adoptCloudflareZone(env: CloudflareEnv, domain: DomainRow): Promise<DomainRow> {
	if (!shouldAdoptZone(domain, hasCloudflareCredentials(env))) return domain;
	let zone: { id: string; name: string } | null;
	try {
		zone = await findZoneByHostname(env, domain.hostname);
	} catch (error) {
		const reason = error instanceof Error ? `: ${error.message}` : "";
		throw new ZoneAdoptionError(
			"ZONE_LOOKUP_FAILED",
			`Could not ask Cloudflare for the zone of ${domain.hostname}${reason}`,
		);
	}
	if (!zone) {
		throw new ZoneAdoptionError(
			"ZONE_NOT_FOUND",
			`No Cloudflare zone on this account holds ${domain.hostname}. Add the domain to Cloudflare first, or set its DNS records where its nameservers are hosted.`,
		);
	}
	const db = getDb(env);
	const [claimed] = await db
		.select({ id: domains.id })
		.from(domains)
		.where(and(eq(domains.zoneId, zone.id), ne(domains.userId, domain.userId)))
		.limit(1);
	if (claimed) throw new ZoneAdoptionError("ZONE_CLAIMED", "Cloudflare zone is already registered to another account");
	await db.update(domains).set({ zoneId: zone.id }).where(eq(domains.id, domain.id));
	return { ...domain, zoneId: zone.id };
}
