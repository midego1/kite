/**
 * A per-user budget on the remote image proxy, so a signed-in account cannot turn it into a
 * high-volume fetcher. A limiter error lets the request through: the proxy only fetches images
 * named in the reader's own messages, so availability wins over a missed count.
 */
export async function allowRemoteImageRequest(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.REMOTE_IMAGE_RATE_LIMIT) return true;
	try {
		return (await env.REMOTE_IMAGE_RATE_LIMIT.limit({ key: userId })).success;
	} catch (error) {
		console.warn("Remote image rate limiter unavailable", error);
		return true;
	}
}
