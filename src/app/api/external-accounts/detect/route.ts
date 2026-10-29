import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { CONNECT_REFUSAL_TEXT, connectRefusal } from "@/lib/external-accounts/access";
import { detectPreset } from "@/lib/external-accounts/detect";

/** A lookup may ask DNS for the domain's MX records, so each user gets a budget (the login limiter's, per user). */
async function allowDetect(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `external-detect:${userId}` })).success;
	} catch (error) {
		console.warn("external.detect_rate_limiter_unavailable", error instanceof Error ? error.name : "unknown");
		return true;
	}
}

/**
 * The provider an address most likely belongs to, by its domain or its domain's MX records; `other` when unsure.
 * Only for users who may connect accounts.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const refusal = await connectRefusal(env, auth.user.id);
	if (refusal)
		return Response.json(
			{ error: CONNECT_REFUSAL_TEXT[refusal], code: refusal.toUpperCase() },
			{ status: refusal === "not_permitted" ? 403 : 409 },
		);
	if (!(await allowDetect(env, auth.user.id)))
		return Response.json({ error: "Too many lookups. Try again in a minute.", code: "RATE_LIMITED" }, { status: 429 });
	const address = new URL(request.url).searchParams.get("address")?.slice(0, 254) ?? "";
	const preset = await detectPreset(address);
	return Response.json({ preset: preset.id }, { headers: { "Cache-Control": "no-store" } });
}
