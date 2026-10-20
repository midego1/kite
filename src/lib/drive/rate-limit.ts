function clientIp(request: Request): string {
	return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

async function allow(limiter: RateLimit | undefined, key: string, name: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key })).success;
	} catch (error) {
		console.warn(`${name} rate limiter unavailable`, error);
		return true;
	}
}

/** Public link views and downloads take no login, so each IP gets a budget against token guessing. */
export function allowPublicLinkRequest(env: CloudflareEnv, request: Request): Promise<boolean> {
	return allow(env.DRIVE_LINK_RATE_LIMIT, clientIp(request), "Drive link");
}

/** Password attempts on one link from one IP share the login budget. */
export function allowLinkUnlockAttempt(env: CloudflareEnv, request: Request, linkId: string): Promise<boolean> {
	return allow(env.LOGIN_RATE_LIMIT, `drive-unlock:${clientIp(request)}:${linkId}`, "Drive unlock");
}
