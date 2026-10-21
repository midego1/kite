import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { requireManagedDomain } from "@/lib/api/domain-access";
import { getDomainProvisioningError } from "@/lib/domains/errors";
import { domainUpdateSchema } from "@/lib/validators";
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { getDomainForUser, removeDomainForUser } from "@/lib/domains/service";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ domain });
}

/** Sets or clears the "DNS skipped" warning, for when the admin has set the records up by hand. */
export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const { domain, error } = await requireManagedDomain(env, request, id);
	if (error) return error;
	const parsed = domainUpdateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return NextResponse.json({ error: "Only dnsSkipped (true or false) can be changed" }, { status: 400 });
	try {
		await getDb(env).update(domains).set({ dnsSkipped: parsed.data.dnsSkipped }).where(eq(domains.id, domain.id));
	} catch (err) {
		const failure = getDomainProvisioningError(err, "Failed to update domain", 500);
		return NextResponse.json({ error: failure.message, code: failure.code }, { status: failure.status });
	}
	return NextResponse.json({ domain: { ...domain, dnsSkipped: parsed.data.dnsSkipped } });
}

export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	try {
		const result = await removeDomainForUser(env, user.id, id);
		return NextResponse.json({ ok: true, ...result });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to remove domain";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
