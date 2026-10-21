import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { canManageDomains } from "@/lib/auth/admin";
import { getDomainForUser } from "@/lib/domains/service";
import { parseDnsSetupInput, setupDnsRecordView } from "@/lib/domains/dns-setup-request";
import { MxConflictError } from "@/lib/domains/receiving-dns";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!canManageDomains(auth.user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

	const { id } = await params;
	const domain = await getDomainForUser(env, auth.userId, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	const input = parseDnsSetupInput(await request.json().catch(() => ({})));
	if (!input) return NextResponse.json({ error: "Unknown DNS record" }, { status: 400 });

	try {
		return NextResponse.json(await setupDnsRecordView(env, domain, input));
	} catch (err) {
		// 409 MX_CONFLICT asks the caller to confirm and retry with replaceMx.
		if (err instanceof MxConflictError)
			return NextResponse.json({ error: err.message, code: err.code, records: err.records }, { status: 409 });
		const message = err instanceof Error ? err.message : "Failed to set up DNS record";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
