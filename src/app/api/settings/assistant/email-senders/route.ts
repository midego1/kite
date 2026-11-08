import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { addSenderAddress, listSenderAddresses, SenderAddressesPendingError } from "@/lib/agent/email/sender-addresses";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const addresses = await listSenderAddresses(getDb(env), auth.user.id);
	return NextResponse.json({ addresses });
}

/**
 * Adds a pending address and emails it a verification code (spec §5.3). The response never says whether the
 * address was new, already pending, already verified, or belongs to someone else: the same "code sent" state
 * either way, so this route cannot be used to find out who uses Kite's assistant or who owns an address.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { address?: unknown } | null;
	if (typeof body?.address !== "string" || !body.address.trim())
		return NextResponse.json({ error: "An email address is required" }, { status: 400 });
	try {
		await addSenderAddress(env, getDb(env), auth.user.id, body.address);
	} catch (error) {
		if (!(error instanceof SenderAddressesPendingError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 409 });
	}
	return NextResponse.json({ ok: true });
}
