import { getNodeEnv } from "@/lib/runtime";
import { isPrivateIpAddress } from "./outbound-url";

/**
 * Which private addresses a request to a user-supplied address may still reach, on top of public ones. Each caller
 * passes what its own flags allow, so the connection check never lets through more than its address check did.
 */
export type OutboundAddressPolicy = {
	/** Loopback addresses (127.0.0.0/8, ::1): the dev-only flags for local fakes. */
	allowLoopback?: boolean;
	/** Every private and reserved address: `STORAGE_ALLOW_PRIVATE_ENDPOINTS` (MinIO or a NAS beside the Node server). */
	allowPrivate?: boolean;
};

/**
 * The Node server's `env.PINNED_FETCH` (`server/runtime/pinned-fetch.ts`): fetch whose every connection, the first
 * and each redirect, resolves the host once, refuses it when any address breaks `policy`, and connects to an address
 * it checked, with the original Host header and TLS server name.
 */
export type PinnedFetch = (
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	policy: OutboundAddressPolicy,
) => Promise<Response>;

export type OutboundFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** @public Exercised by the unit tests. Whether a connection may go to `address` (an IP literal) under `policy`. */
export function isAllowedOutboundAddress(address: string, policy: OutboundAddressPolicy): boolean {
	const value = address.replace(/^\[|\]$/g, "").toLowerCase();
	if (!isPrivateIpAddress(value)) return true;
	if (policy.allowPrivate) return true;
	return !!policy.allowLoopback && isLoopbackAddress(value);
}

function isLoopbackAddress(value: string): boolean {
	const v4 = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
	return value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * fetch for an address a user supplied (webhooks, the remote image proxy, object storage stores, linked WebDAV
 * folders), after the caller's own address check. On the Node server it goes through `PINNED_FETCH`, which closes
 * the DNS-rebinding window between that check and the connection. Workers cannot reach private networks at all
 * (`global_fetch_strictly_public`), so there it is the platform's fetch.
 */
export function outboundFetch(
	env: Partial<Pick<CloudflareEnv, "PINNED_FETCH">> | null | undefined,
	policy: OutboundAddressPolicy = {},
): OutboundFetch {
	const pinned = env?.PINNED_FETCH ?? getNodeEnv()?.PINNED_FETCH;
	if (!pinned) return (input, init) => fetch(input, init);
	return (input, init) => pinned(input, init, policy);
}
