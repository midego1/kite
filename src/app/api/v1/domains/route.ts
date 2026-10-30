import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { canManageDomains } from "@/lib/auth/admin";
import { addDomainSchema } from "@/lib/validators";
import { addDomainAsRequested, listUserDomains } from "@/lib/domains/service";
import { getDomainDnsView, summariseDomainDns } from "@/lib/domains/dns-view";
import { getDomainProvisioningError } from "@/lib/domains/errors";
import { domainOwnerId as ownerId } from "@/lib/domains/owner-utils";
import type { DnsStatusSummary } from "@/lib/dns-status";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const domains = await listUserDomains(env, ownerId(auth.user));
	const results = await Promise.allSettled(domains.map((domain) => summariseDomainDns(env, domain)));

	const dns: Record<string, DnsStatusSummary> = {};
	const domainViews = domains.map((domain, index) => {
		const result = results[index];
		if (result.status !== "fulfilled") return domain;
		dns[domain.id] = result.value.summary;
		return { ...domain, sendingEnabled: result.value.sendingEnabled };
	});

	return NextResponse.json({ domains: domainViews, dns });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!canManageDomains(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

	const parsed = addDomainSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await addDomainAsRequested(env, auth.userId, parsed.data);
		let dns = result.dns;
		try {
			dns = await getDomainDnsView(env, result.domain);
		} catch (error) {
			console.warn("v1 addDomain: failed to read DNS after provisioning", error);
		}
		return NextResponse.json({ ...result, dns });
	} catch (err) {
		const failure = getDomainProvisioningError(err, "Failed to add domain");
		return NextResponse.json({ error: failure.message, code: failure.code }, { status: failure.status });
	}
}
