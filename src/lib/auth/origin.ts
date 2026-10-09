import { isAllowedMutationRequest } from "@/lib/security/csrf";

/** Call only after session authentication. Bearer tokens are not sent automatically by browsers. */
export function hasValidSessionMutationOrigin(request: Request): boolean {
	return isAllowedMutationRequest({
		authorization: request.headers.get("Authorization"),
		fetchSite: request.headers.get("Sec-Fetch-Site"),
		origin: request.headers.get("Origin"),
		allowedHosts: [new URL(request.url).host],
	});
}
