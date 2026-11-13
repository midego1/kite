import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { PinnedPost } from "../../src/lib/net/types";
import { isPrivateIpAddress, OutboundUrlError } from "../../src/lib/security/outbound-url";

type PinnedPostOptions = {
	/** Every address of a name; the default is `dns.lookup` with `all: true`. */
	resolve?: (hostname: string) => Promise<string[]>;
	/** Tests only: 127.0.0.1 and ::1 are allowed. Never read from the environment. */
	allowLoopback?: boolean;
};

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

async function resolveAll(hostname: string): Promise<string[]> {
	return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** Every address `hostname` resolves to, or an `OutboundUrlError` when there is none or any of them is private. */
async function vetPublicAddresses(
	hostname: string,
	resolve: (hostname: string) => Promise<string[]>,
	allowLoopback = false,
): Promise<string[]> {
	const host = hostname.replace(/^\[|\]$/g, "");
	let addresses: string[];
	if (isIP(host)) addresses = [host];
	else {
		try {
			addresses = await resolve(host);
		} catch {
			throw new OutboundUrlError(`Could not resolve ${host}`);
		}
	}
	if (!addresses.length) throw new OutboundUrlError(`Could not resolve ${host}`);
	const refused = addresses.some((address) => isPrivateIpAddress(address) && !(allowLoopback && LOOPBACK.has(address)));
	if (refused) throw new OutboundUrlError("Private and local addresses are not allowed");
	return addresses;
}

/** A `lookup` for `net`/`tls` that answers only the vetted addresses, whatever the name now resolves to. */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
	const entries = addresses.map((address) => ({ address, family: isIP(address) }));
	return (_hostname, options, callback) => {
		if (options.all) callback(null, entries);
		else callback(null, entries[0]!.address, entries[0]!.family);
	};
}

/** The Node server's `env.PINNED_POST`; see `PinnedPost`. A fresh connection each time, never a pooled one. */
export function createPinnedPost(options: PinnedPostOptions = {}): PinnedPost {
	const resolve = options.resolve ?? resolveAll;
	return async (url, { body, headers, signal }) => {
		const target = new URL(url);
		if (target.protocol !== "https:" && target.protocol !== "http:")
			throw new OutboundUrlError("Only http and https URLs are allowed");
		const addresses = await vetPublicAddresses(target.hostname, resolve, options.allowLoopback);
		signal.throwIfAborted();
		const send = target.protocol === "https:" ? httpsRequest : httpRequest;
		return new Promise<{ status: number }>((resolveStatus, reject) => {
			const request = send(
				target,
				{
					method: "POST",
					headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
					lookup: pinnedLookup(addresses),
					agent: false,
					signal,
				},
				(response: IncomingMessage) => {
					// Only the status matters; the body is discarded unread.
					response.resume();
					resolveStatus({ status: response.statusCode ?? 0 });
				},
			);
			request.on("error", reject);
			request.end(body);
		});
	};
}
