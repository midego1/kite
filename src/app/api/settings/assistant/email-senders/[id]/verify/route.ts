import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { SenderAddressesPendingError, verifySenderAddress } from "@/lib/agent/email/sender-addresses";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
	if (typeof body?.code !== "string" || !body.code.trim())
		return NextResponse.json({ error: "A code is required" }, { status: 400 });
	let verified: boolean;
	try {
		verified = await verifySenderAddress(env, getDb(env), auth.user.id, id, body.code.trim());
	} catch (error) {
		if (!(error instanceof SenderAddressesPendingError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
	if (!verified) return NextResponse.json({ error: "That code is wrong or has expired" }, { status: 400 });
	return NextResponse.json({ ok: true });
}
