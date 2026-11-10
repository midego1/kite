import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { McpConsent } from "@/components/oauth/mcp-consent";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { authPageMetadata } from "../../auth-metadata";

export const dynamic = "force-dynamic";

export const generateMetadata = () => authPageMetadata("Connect an app");

/**
 * The OAuth authorization endpoint of MCP over OAuth. Only a signed-in user sees the consent screen; anyone else signs
 * in first and comes back here. The request itself is validated by `/api/oauth/authorize`.
 */
export default async function McpAuthorizePage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const query = new URLSearchParams();
	for (const [name, value] of Object.entries(await searchParams))
		for (const item of [value].flat()) if (item !== undefined) query.append(name, item);
	const env = getEnv();
	const cookieStore = await cookies();
	const user = await getUserFromSession(env, cookieStore.get(SESSION_COOKIE)?.value);
	if (!user || user.disabled) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
	return (
		<AuthGuard>
			<McpConsent query={query.toString()} />
		</AuthGuard>
	);
}
