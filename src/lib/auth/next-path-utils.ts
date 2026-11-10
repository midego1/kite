import { isSameOriginPath } from "@/lib/modules/path-utils";

/**
 * Where sign-in may send the browser afterwards: only back to an MCP app's consent screen, so `?next=` can never
 * become an open redirect or deep-link into anything else.
 */
export function loginNextPath(value: unknown): string | null {
	if (!isSameOriginPath(value)) return null;
	return value === "/oauth/authorize" || value.startsWith("/oauth/authorize?") ? value : null;
}
