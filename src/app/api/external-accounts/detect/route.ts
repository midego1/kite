import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { detectPreset } from "@/lib/external-accounts/detect";

/** The provider an address most likely belongs to, by its domain or its domain's MX records; `other` when unsure. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const address = new URL(request.url).searchParams.get("address")?.slice(0, 254) ?? "";
	const preset = await detectPreset(address);
	return Response.json({ preset: preset.id }, { headers: { "Cache-Control": "no-store" } });
}
