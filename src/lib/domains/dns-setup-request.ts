import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { selectRow } from "@/lib/db/pending-columns";
import { getDomainDnsView } from "@/lib/domains/dns-view";
import type { DnsAuthRecord } from "@/lib/domains/dns-audit";
import { setupDomainDnsRecord } from "@/lib/domains/dns-setup";
import { MxConflictError } from "@/lib/domains/receiving-dns";
import { getDomainForUser } from "@/lib/domains/service";
import type { DomainRow } from "@/lib/domains/types";
import { adoptCloudflareZone } from "@/lib/domains/adopt-zone";
import { zoneAdoptionFailure } from "@/lib/domains/skip-dns-utils";

const DNS_RECORDS: DnsAuthRecord[] = ["mx", "spf", "dkim", "dmarc"];

/** What a DNS setup request asks for, or null when it names no known record. */
export function parseDnsSetupInput(body: unknown): { record: DnsAuthRecord; replaceMx: boolean } | null {
	const input = (body && typeof body === "object" ? body : {}) as { record?: unknown; replaceMx?: unknown };
	const record = input.record as DnsAuthRecord;
	if (!DNS_RECORDS.includes(record)) return null;
	return { record, replaceMx: input.replaceMx === true };
}

/**
 * Creates the record, then reads back the domain row and DNS view the page shows. A domain
 * added with DNS skipped gets its Cloudflare zone first; that throws `ZoneAdoptionError`.
 */
export async function setupDnsRecordView(
	env: CloudflareEnv,
	skippedOrManaged: DomainRow,
	input: { record: DnsAuthRecord; replaceMx: boolean },
) {
	const domain = await adoptCloudflareZone(env, skippedOrManaged);
	await setupDomainDnsRecord(env, domain, input.record, { replaceMx: input.replaceMx });
	const dns = await getDomainDnsView(env, domain);
	const updated = await selectRow(getDb(env), domains, eq(domains.id, domain.id));
	return { domain: { ...(updated ?? domain), sendingEnabled: dns.sendingEnabled }, dns };
}

/** A JSON answer for a route to send as is. */
export type DnsSetupAnswer = { status: number; body: Record<string, unknown> };

/**
 * The session route's whole answer for creating one missing DNS record on a domain the
 * user owns. 409 MX_CONFLICT asks the caller to confirm and retry with `replaceMx`.
 */
export async function answerDnsSetupRequest(
	env: CloudflareEnv,
	userId: string,
	domainId: string,
	body: unknown,
): Promise<DnsSetupAnswer> {
	const domain = await getDomainForUser(env, userId, domainId);
	if (!domain) return { status: 404, body: { error: "Not found" } };
	const input = parseDnsSetupInput(body);
	if (!input) return { status: 400, body: { error: "Unknown DNS record" } };
	try {
		return { status: 200, body: await setupDnsRecordView(env, domain, input) };
	} catch (err) {
		if (err instanceof MxConflictError)
			return { status: 409, body: { error: err.message, code: err.code, records: err.records } };
		const adoption = zoneAdoptionFailure(err);
		if (adoption) return adoption;
		return { status: 500, body: { error: err instanceof Error ? err.message : "Failed to set up DNS record" } };
	}
}
