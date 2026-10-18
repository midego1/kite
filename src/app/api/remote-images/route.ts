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
import { isNodeRuntime } from "@/lib/runtime";

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

/**
 * Serves a remote image named in a message the signed-in user can read, from this origin, so
 * images whose host sends `Cross-Origin-Resource-Policy: same-origin` still show once the reader
 * has allowed remote images. Workers only: the self-hosted server could reach its private
 * network through a hostname that resolves there, so it refuses and the reader loads such
 * images directly.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (isNodeRuntime(env)) return failure("Remote images are not proxied by the self-hosted server", 503);

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
		const image = await fetchRemoteImage(imageUrl, policy);
		return new Response(image.body, { headers: { ...IMAGE_HEADERS, "Content-Type": image.contentType } });
	} catch (error) {
		if (error instanceof RemoteImageError) return failure(error.message, error.status);
		return failure("Could not fetch remote image", 502);
	}
}
