import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { preflightDomain } from "@/lib/domains/preflight";
import { setupDomainSchema } from "@/lib/validators";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = setupDomainSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		return NextResponse.json({ domain: await preflightDomain(env, parsed.data.hostname) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Domain check failed";
		return NextResponse.json({ error: message }, { status: 502 });
	}
}
