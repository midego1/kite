import { isBlockedHost, isIpAddressLiteral, isPrivateIpAddress } from "@/lib/security/outbound-url";
import type { S3Location } from "./types";

/** What the endpoint guard lets through beyond public https hosts. */
export type EndpointPolicy = {
	/** `STORAGE_ALLOW_INSECURE_ENDPOINT`: plain http and loopback hosts, for a fake store or MinIO in dev and e2e. */
	allowInsecure: boolean;
	/** `STORAGE_ALLOW_PRIVATE_ENDPOINTS`: private and LAN hosts (MinIO beside the Node server), over http or https. */
	allowPrivate: boolean;
};

const isOn = (flag: string | undefined) => flag === "1" || flag === "true";

/**
 * The insecure flag is ignored in production, like `ALERT_WEBHOOK_ALLOW_INSECURE`. The private flag is honoured only
 * by the Node server: a self-hosted install may keep MinIO on its own network, while a Worker cannot reach one
 * (`global_fetch_strictly_public`) and must never be told it may.
 */
export function storageEndpointPolicy(
	env: Partial<
		Pick<CloudflareEnv, "STORAGE_ALLOW_INSECURE_ENDPOINT" | "STORAGE_ALLOW_PRIVATE_ENDPOINTS" | "KITE_RUNTIME">
	>,
	nodeEnv: string | undefined,
): EndpointPolicy {
	return {
		allowInsecure: isOn(env.STORAGE_ALLOW_INSECURE_ENDPOINT) && nodeEnv !== "production",
		allowPrivate: isOn(env.STORAGE_ALLOW_PRIVATE_ENDPOINTS) && env.KITE_RUNTIME === "node",
	};
}

/** `storage_stores.endpoint` keeps the host alone, with an `http://` prefix only for a store a flag allowed. */
export function storedEndpoint(location: Pick<S3Location, "endpoint" | "scheme">): string {
	return location.scheme === "http" ? `http://${location.endpoint}` : location.endpoint;
}

export function parseStoredEndpoint(stored: string): Pick<S3Location, "endpoint" | "scheme"> {
	return stored.startsWith("http://")
		? { endpoint: stored.slice("http://".length), scheme: "http" }
		: { endpoint: stored, scheme: "https" };
}

/** The host of `host:port`, `[::1]:9000` or `::1` without brackets or port. */
export function endpointHostname(endpoint: string): string {
	const value = endpoint.trim().toLowerCase();
	if (value.startsWith("[")) return value.slice(1, value.indexOf("]") > 0 ? value.indexOf("]") : undefined);
	if (isIpAddressLiteral(value)) return value;
	return value.replace(/:\d+$/, "");
}

/** @public Exercised by the unit tests. */
export function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "::1" ||
		(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) && isPrivateIpAddress(hostname))
	);
}

/** The literal half of the guard: why this endpoint is refused under the policy, or null. */
export function endpointProblem(
	location: Pick<S3Location, "endpoint" | "scheme">,
	policy: EndpointPolicy,
): string | null {
	const hostname = endpointHostname(location.endpoint);
	if (!hostname) return "Enter the endpoint";
	const loopback = isLoopbackHostname(hostname);
	const local = loopback || isBlockedHost(hostname);
	if (local && !(policy.allowPrivate || (loopback && policy.allowInsecure)))
		return "Private and local addresses are not allowed for a store";
	if (location.scheme === "http" && !(policy.allowInsecure || (policy.allowPrivate && local)))
		return "The endpoint must use https";
	return null;
}

/** True when the endpoint is a local host a flag allowed, so resolving it to check for private addresses is moot. */
export function isAllowedLocalEndpoint(location: Pick<S3Location, "endpoint">, policy: EndpointPolicy): boolean {
	const hostname = endpointHostname(location.endpoint);
	if (policy.allowPrivate) return true;
	return policy.allowInsecure && isLoopbackHostname(hostname);
}
