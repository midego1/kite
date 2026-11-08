import { eq, inArray, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { assistantAddresses } from "@/db/schema/assistant-email";
import { requireSessionAdmin } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import {
	assistantAddressesPendingResponse,
	assistantAddressesReady,
	checkAssistantAddress,
	managedDomain,
	publicAssistantAddress,
} from "./utils";

/** Every assistant address on a domain this admin can manage (Domains → domain details, spec §14). */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, canManageDomains);
	if (auth.error) return auth.error;
	const db = getDb(env);
	if (!(await assistantAddressesReady(db))) return assistantAddressesPendingResponse();
	const managed = await db
		.select({ id: domains.id, hostname: domains.hostname })
		.from(domains)
		.where(
			or(
				eq(domains.userId, auth.user.id),
				auth.user.createdByUserId ? eq(domains.userId, auth.user.createdByUserId) : undefined,
			),
		);
	if (managed.length === 0) return NextResponse.json({ assistantAddresses: [] });
	const hostnames = new Map(managed.map((domain) => [domain.id, domain.hostname]));
	const rows = await db
		.select()
		.from(assistantAddresses)
		.where(
			inArray(
				assistantAddresses.domainId,
				managed.map((domain) => domain.id),
			),
		);
	return NextResponse.json({
		assistantAddresses: rows.map((row) => publicAssistantAddress(row, hostnames.get(row.domainId) ?? "")),
	});
}

/** Creates the domain's assistant address (spec §13): `ADDRESS_IN_USE` and `DOMAIN_NOT_READY` on a 409. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, canManageDomains);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	const body = (await request.json().catch(() => null)) as { domainId?: unknown; localPart?: unknown } | null;
	const domainId = typeof body?.domainId === "string" ? body.domainId : "";
	const localPart = typeof body?.localPart === "string" ? normalizeRecipientLocalPart(body.localPart) : "";
	if (!domainId || !localPart) return NextResponse.json({ error: "Enter a domain and an address" }, { status: 400 });

	const db = getDb(env);
	if (!(await assistantAddressesReady(db))) return assistantAddressesPendingResponse();
	const domain = await managedDomain(db, auth.user, domainId);
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });

	const checked = await checkAssistantAddress(db, domain, localPart);
	if (!checked.ok) return NextResponse.json({ error: checked.error, code: checked.code }, { status: 409 });

	const id = newId("asa");
	await db.insert(assistantAddresses).values({ id, domainId: domain.id, localPart, createdByUserId: auth.user.id });
	try {
		// Without this, Cloudflare never forwards mail for the address to the Worker at all: creating the row alone
		// would silently do nothing on a real domain, exactly like a mailbox or alias (`ensureMailboxDomainRouting`,
		// `ensureEmailRoutingRuleToWorker` in the aliases route).
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${localPart}@${domain.hostname}`);
	} catch (err) {
		await db.delete(assistantAddresses).where(eq(assistantAddresses.id, id));
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}
	const [row] = await db.select().from(assistantAddresses).where(eq(assistantAddresses.id, id)).limit(1);
	return NextResponse.json({ assistantAddress: publicAssistantAddress(row!, domain.hostname) }, { status: 201 });
}
