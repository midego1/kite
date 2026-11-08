import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { assistantAddresses } from "@/db/schema/assistant-email";
import { requireSessionAdmin } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { managedDomain, publicAssistantAddress } from "../utils";

type Params = { params: Promise<{ id: string }> };

async function ownedAssistantAddress(request: Request, id: string) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, canManageDomains);
	if (auth.error) return { error: auth.error } as const;
	const db = getDb(env);
	const [row] = await db.select().from(assistantAddresses).where(eq(assistantAddresses.id, id)).limit(1);
	if (!row) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
	const domain = await managedDomain(db, auth.user, row.domainId);
	if (!domain) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
	return { env, db, row, domain } as const;
}

/** Enables or disables the address (spec §14); disabling never deletes it. */
export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	const owned = await ownedAssistantAddress(request, id);
	if (owned.error) return owned.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
	if (typeof body?.enabled !== "boolean")
		return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
	await owned.db.update(assistantAddresses).set({ enabled: body.enabled }).where(eq(assistantAddresses.id, id));
	return NextResponse.json({
		assistantAddress: publicAssistantAddress({ ...owned.row, enabled: body.enabled }, owned.domain.hostname),
	});
}

export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	const owned = await ownedAssistantAddress(request, id);
	if (owned.error) return owned.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	await owned.db.delete(assistantAddresses).where(eq(assistantAddresses.id, id));
	return NextResponse.json({ ok: true });
}
