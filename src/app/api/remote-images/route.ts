import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import {
	fetchRemoteImage,
	isRemoteImageLoopbackAllowed,
	parseRemoteImageUrl,
	RemoteImageError,
} from "@/lib/remote-images/fetch-utils";
import { canProxyMessageImage } from "@/lib/remote-images/message-access";
import { allowRemoteImageRequest } from "@/lib/remote-images/rate-limit";
import { assertPublicHttpUrl, OutboundUrlError } from "@/lib/security/outbound-url";

const IMAGE_HEADERS = {
	// The URL names a message only its readers can open; private keeps it out of shared caches.
	"Cache-Control": "private, max-age=3600",
	Vary: "Cookie",
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function failure(error: string, status: number) {
	return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

async function checkPublicHop(env: CloudflareEnv, url: URL, policy: { allowLoopback: boolean }): Promise<void> {
	// parseRemoteImageUrl already admitted the e2e image server under the dev-only loopback flag.
	if (policy.allowLoopback && url.hostname === "127.0.0.1") return;
	try {
		await assertPublicHttpUrl(env, url.href);
	} catch (error) {
		if (error instanceof OutboundUrlError) throw new RemoteImageError(error.message, 400, "invalid_url");
		throw error;
	}
}

/**
 * Serves a remote image named in a message the signed-in user can read, from this origin, so
 * images whose host sends `Cross-Origin-Resource-Policy: same-origin` still show once the reader
 * has allowed remote images. Every hop, the first URL and each redirect, goes through
 * `assertPublicHttpUrl`, which on the self-hosted server also resolves the name and refuses a
 * private address (fetch cannot pin the address, so a small rebinding window remains). Adapted
 * from upstream Mailflare #220.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const requestUrl = new URL(request.url);
	const messageId = requestUrl.searchParams.get("message") ?? "";
	const imageUrl = requestUrl.searchParams.get("url") ?? "";
	if (!messageId || !imageUrl) return failure("message and url are required", 400);
	if (!(await allowRemoteImageRequest(env, auth.user.id))) return failure("Too many remote image requests", 429);

	const policy = {
		appOrigin: requestUrl.origin,
		allowLoopback: isRemoteImageLoopbackAllowed(env.REMOTE_IMAGES_ALLOW_LOOPBACK, process.env.NODE_ENV),
	};
	try {
		parseRemoteImageUrl(imageUrl, policy);
		if (!(await canProxyMessageImage(env, auth.user, messageId, imageUrl, requestUrl.origin)))
			return failure("Image not found", 404);
		const image = await fetchRemoteImage(imageUrl, { ...policy, checkHop: (url) => checkPublicHop(env, url, policy) });
		return new Response(image.body, { headers: { ...IMAGE_HEADERS, "Content-Type": image.contentType } });
	} catch (error) {
		if (error instanceof RemoteImageError) return failure(error.message, error.status);
		return failure("Could not fetch remote image", 502);
	}
}
