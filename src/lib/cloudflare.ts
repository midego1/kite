import { env } from "cloudflare:workers";
import { getNodeEnv } from "@/lib/runtime";
import { withStorage } from "@/lib/storage/router";

/** The platform env with `BUCKET` routed to each object class's store (src/lib/storage/router.ts). */
export function getEnv(): CloudflareEnv {
	return withStorage(getNodeEnv() ?? (env as CloudflareEnv));
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
	return getEnv();
}
