import { storageJson } from "./admin-api";
import type { R2SetupResult } from "./auto-setup";
import { recordStorageAttempt } from "./test-limit";
import { createLogger } from "@/lib/logger.mjs";

const log = createLogger("storage");

/**
 * Counts a one-click attempt against the admin's budget (five a minute) before anything reaches Cloudflare. The
 * limit fails closed: when it cannot be checked, the attempt is refused.
 */
export async function autoSetupAttempt(
	env: CloudflareEnv,
	actorId: string,
	metadata: Record<string, unknown>,
): Promise<{ id: string } | { error: Response }> {
	try {
		const attempt = await recordStorageAttempt(env, actorId, "storage.auto_setup", metadata);
		return attempt.allowed
			? { id: attempt.id }
			: { error: storageJson({ error: "Too many setup attempts; wait a minute and try again" }, 429) };
	} catch (error) {
		log.error("storage.auto_setup_limit_unavailable", { error });
		return { error: storageJson({ error: "Could not check the attempt limit; try again in a moment" }, 503) };
	}
}

/** The result as a response: the step list either way, the saved store on success, never a key. */
export function autoSetupResponse(result: R2SetupResult): Response {
	if (result.ok) return storageJson({ steps: result.steps, store: result.store, report: result.report });
	const { ok: _ok, status, ...body } = result;
	return storageJson(body, status);
}

/**
 * The bucket picker asks Cloudflare on every open, so each admin gets the login limiter's budget under its own key.
 * Reading a list changes nothing, so a limiter that errors lets the request through, and says so in the log.
 */
export async function allowR2Listing(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `storage-r2-buckets:${userId}` })).success;
	} catch (error) {
		log.warn("storage.r2_listing_limiter_unavailable", { error });
		return true;
	}
}
