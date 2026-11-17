import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import {
	isAllowedOutboundAddress,
	type OutboundAddressPolicy,
	type PinnedFetch,
} from "../../src/lib/security/outbound-fetch";

/** A connection refused because the host is, or resolves to, an address the caller's policy does not allow. */
class OutboundAddressRefusedError extends Error {
	readonly code = "ERR_OUTBOUND_ADDRESS_REFUSED";
	constructor() {
		super("Private and local addresses are not allowed");
	}
}

export type PinnedFetchOptions = {
	/** Every address of a name; the default is `dns.lookup` with `all: true`. */
	resolve?: (hostname: string) => Promise<string[]>;
};

async function resolveAll(hostname: string): Promise<string[]> {
	return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function notFound(hostname: string): Error {
	return Object.assign(new Error(`Could not resolve ${hostname}`), { code: "ENOTFOUND", hostname });
}

/**
 * The `lookup` the sockets use instead of the system's: one resolution, every address checked, and only checked
 * addresses handed back, so the socket can only connect to one of them. Node calls it with `all: true` when it tries
 * several addresses (`autoSelectFamily`), else for one.
 */
function vettedLookup(policy: OutboundAddressPolicy, resolve: (hostname: string) => Promise<string[]>): LookupFunction {
	return (hostname, options, callback) => {
		resolve(hostname)
			.then((addresses) => {
				if (!addresses.length) throw notFound(hostname);
				if (!addresses.every((address) => isAllowedOutboundAddress(address, policy)))
					throw new OutboundAddressRefusedError();
				const family = typeof options.family === "number" ? options.family : 0;
				const entries = addresses
					.map((address) => ({ address, family: isIP(address) }))
					.filter((entry) => !family || entry.family === family);
				if (!entries.length) throw notFound(hostname);
				if (options.all) callback(null, entries);
				else callback(null, entries[0].address, entries[0].family);
			})
			.catch((error: NodeJS.ErrnoException) => callback(error, ""));
	};
}

/**
 * The Node server's `env.PINNED_FETCH`. An undici Agent per policy whose connector checks an IP-literal host itself
 * and gives sockets `vettedLookup` for a name, so the address checked is the address dialled: a name that answers
 * with a public address to the caller's check and a private one a moment later (DNS rebinding) cannot reach the
 * private one. TLS keeps the host name for SNI and the certificate check; the Host header is the URL's. Redirects
 * followed by fetch connect through the same connector.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): PinnedFetch {
	const resolve = options.resolve ?? resolveAll;
	const agents = new Map<string, Agent>();
	const agentFor = (policy: OutboundAddressPolicy) => {
		const key = `${!!policy.allowLoopback}:${!!policy.allowPrivate}`;
		let agent = agents.get(key);
		if (!agent) {
			const connect = buildConnector({ lookup: vettedLookup(policy, resolve) } as buildConnector.BuildOptions);
			agent = new Agent({
				connect: (connectOptions, callback) => {
					const host = connectOptions.hostname.replace(/^\[|\]$/g, "");
					if (isIP(host) && !isAllowedOutboundAddress(host, policy))
						return callback(new OutboundAddressRefusedError(), null);
					return connect(connectOptions, callback);
				},
			});
			agents.set(key, agent);
		}
		return agent;
	};
	return (input, init, policy) => {
		// Callers pass the address; a Request would carry another runtime's body and signal.
		if (typeof input !== "string" && !(input instanceof URL))
			return Promise.reject(new TypeError("PINNED_FETCH takes a URL and an init"));
		return undiciFetch(input, {
			...(init as Parameters<typeof undiciFetch>[1]),
			dispatcher: agentFor(policy),
		}) as unknown as Promise<Response>;
	};
}
