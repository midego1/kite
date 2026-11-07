import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getAwsConfig } from "@/lib/aws/config";
import { getSesReceivingView } from "@/lib/aws/ses-receiving";
import { getDomainForUser } from "@/lib/domains/service";
import { setupReceiving } from "@/lib/domains/receiving";
import { MxConflictError } from "@/lib/domains/receiving-dns";
import { getResendReceivingView } from "@/lib/domains/resend-receiving";
import { zoneAdoptionFailure } from "@/lib/domains/skip-dns-utils";

type Params = { params: Promise<{ id: string; provider: string }> };
const noStore = { "Cache-Control": "no-store" };
const providerSchema = z.enum(["cloudflare", "resend", "ses"]);

const originOf = (env: CloudflareEnv, request: Request) => env.APP_URL?.trim() || new URL(request.url).origin;

/** Setup status for a receiving provider: a checklist of what exists and what is missing. */
export async function GET(request: Request, { params }: Params) {
	const { id, provider: rawProvider } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const provider = providerSchema.safeParse(rawProvider);
	if (!provider.success || provider.data === "cloudflare")
		return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
	try {
		if (provider.data === "ses") {
			if (!(await getAwsConfig(env)))
				return NextResponse.json({ credentials: false, view: null }, { headers: noStore });
			return NextResponse.json(
				{ credentials: true, view: await getSesReceivingView(env, domain) },
				{ headers: noStore },
			);
		}
		return NextResponse.json(
			{ credentials: true, view: await getResendReceivingView(env, domain, originOf(env, request)) },
			{ headers: noStore },
		);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Could not reach the provider" },
			{ status: 502 },
		);
	}
}

/** Creates what the provider needs and points the domain's MX at it. 409 MX_CONFLICT asks the caller to confirm replacing other MX records. */
export async function POST(request: Request, { params }: Params) {
	const { id, provider: rawProvider } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const provider = providerSchema.safeParse(rawProvider);
	if (!provider.success) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
	const body = (await request.json().catch(() => ({}))) as { replaceMx?: boolean };
	try {
		await setupReceiving(env, domain, provider.data, originOf(env, request), { replaceMx: body.replaceMx === true });
		// Resend mail is only taken for a domain that receives through Resend (`intakeProviderMail`): with the MX now
		// pointing there, an API-only setup would otherwise lose every message with just a warning in the log.
		if (provider.data === "resend" && domain.receivingProvider !== "resend")
			await getDb(env).update(domains).set({ receivingProvider: "resend" }).where(eq(domains.id, domain.id));
		return NextResponse.json({ ok: true }, { headers: noStore });
	} catch (error) {
		if (error instanceof MxConflictError)
			return NextResponse.json({ error: error.message, code: error.code, records: error.records }, { status: 409 });
		const adoption = zoneAdoptionFailure(error);
		if (adoption) return NextResponse.json(adoption.body, { status: adoption.status });
		return NextResponse.json({ error: error instanceof Error ? error.message : "Setup failed" }, { status: 502 });
	}
}
