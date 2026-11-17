import { env } from "cloudflare:workers";
import { currentD1Session } from "@/lib/d1-session-context";
import { withD1Session } from "@/lib/d1-session-utils";
import { getNodeEnv } from "@/lib/runtime";
import { withStorage } from "@/lib/storage/router";

/**
 * The platform env with `BUCKET` routed to each object class's store (src/lib/storage/router.ts) and, inside a
 * fetch on Workers, `DB` served by the request's D1 read-replica session (src/lib/d1-session-utils.ts).
 */
export function getEnv(): CloudflareEnv {
	const nodeEnv = getNodeEnv();
	if (nodeEnv) return withStorage(nodeEnv);
	const session = currentD1Session();
	const base = env as CloudflareEnv;
	return withStorage(session ? withD1Session(base, session) : base);
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
	return getEnv();
}
