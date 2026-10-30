/**
 * Test connection makes requests to an endpoint the admin types, so each admin gets a budget. It shares the
 * login limiter under its own key prefix, as Drive link unlocks do; a limiter error lets the request through.
 */
export async function allowStorageTest(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `storage-test:${userId}` })).success;
	} catch (error) {
		console.warn("Storage test rate limiter unavailable", error);
		return true;
	}
}
