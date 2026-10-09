import type { ClientIpInput } from "./client-ip-types";

/**
 * The client address for the self-hosted server. `cf-connecting-ip` and
 * `x-forwarded-for` are only believed behind a proxy the operator vouches for
 * (TRUST_PROXY); otherwise any client could pick its own rate-limit bucket.
 * The right-most forwarded entry is the one the trusted proxy appended.
 */
export function resolveClientIp({ trustProxy, socketAddress, cfConnectingIp, forwardedFor }: ClientIpInput): string {
	const socket = normalizeAddress(socketAddress) || "unknown";
	if (!trustProxy) return socket;
	const cf = cfConnectingIp?.trim();
	if (cf) return cf;
	const forwarded = forwardedFor
		?.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return forwarded?.length ? forwarded[forwarded.length - 1] : socket;
}

export function isTrustProxyEnabled(value: string | undefined): boolean {
	return !!value && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeAddress(value: string | null | undefined): string {
	const address = value?.trim() ?? "";
	return address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address;
}
