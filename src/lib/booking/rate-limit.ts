/** Public booking takes no login, so each IP gets a small budget to stop slot flooding. */
export async function allowBookingAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.BOOKING_RATE_LIMIT) return true;
	const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
	try {
		return (await env.BOOKING_RATE_LIMIT.limit({ key: ip })).success;
	} catch (error) {
		console.warn("Booking rate limiter unavailable", error);
		return true;
	}
}
