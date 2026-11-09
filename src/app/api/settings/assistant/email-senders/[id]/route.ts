import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { removeSenderAddress, SenderAddressesPendingError } from "@/lib/agent/email/sender-addresses";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	try {
		await removeSenderAddress(env, getDb(env), auth.user.id, id);
	} catch (error) {
		if (!(error instanceof SenderAddressesPendingError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
	return NextResponse.json({ ok: true });
}
