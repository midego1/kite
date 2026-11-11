async function allowAttempt(env: CloudflareEnv, request: Request, bucket: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
	try {
		const outcome = await env.LOGIN_RATE_LIMIT.limit({ key: bucket + ip });
		return outcome.success;
	} catch (error) {
		console.warn("Login rate limiter unavailable", error);
		return true;
	}
}

export async function allowLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	return allowAttempt(env, request, "");
}

/**
 * Passkey ceremonies count in a bucket of their own (the same limiter under another key): the login page asks for
 * a challenge on every visit to offer passkeys as autofill, which must not use up the password attempts.
 */
export async function allowPasskeyAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	return allowAttempt(env, request, "passkey:");
}
