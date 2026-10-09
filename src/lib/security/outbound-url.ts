/**
 * Guards for requests the server makes to user-supplied addresses (webhooks,
 * IMAP import). Without them a user could make the server reach loopback,
 * the private network or a cloud metadata endpoint.
 */

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);

function parseIpv4(value: string): number | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		result = result * 256 + octet;
	}
	return result;
}

function isBlockedIpv4(value: number): boolean {
	return BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
		const baseValue = parseIpv4(base) ?? 0;
		const size = 2 ** (32 - prefix);
		return value >= baseValue && value < baseValue + size;
	});
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when it is not one. */
function parseIpv6(value: string): number[] | null {
	let input = value.toLowerCase();
	const zone = input.indexOf("%");
	if (zone >= 0) input = input.slice(0, zone);
	if (!input.includes(":")) return null;

	const lastColon = input.lastIndexOf(":");
	const maybeIpv4 = input.slice(lastColon + 1);
	if (maybeIpv4.includes(".")) {
		const ipv4 = parseIpv4(maybeIpv4);
		if (ipv4 === null) return null;
		input = `${input.slice(0, lastColon + 1)}${Math.floor(ipv4 / 65536).toString(16)}:${(ipv4 % 65536).toString(16)}`;
	}

	const halves = input.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (part: string) => (part ? part.split(":") : []);
	const head = parseGroups(halves[0]);
	const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	const values: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		values.push(parseInt(group, 16));
	}
	return values.length === 8 ? values : null;
}

function isBlockedIpv6(groups: number[]): boolean {
	const [a, b, c, d, e, f, g, h] = groups;
	const embeddedIpv4 = g * 65536 + h;
	if (groups.every((group) => group === 0)) return true; // ::
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return true; // ::1
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0))
		return isBlockedIpv4(embeddedIpv4); // mapped / compatible
	if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isBlockedIpv4(embeddedIpv4); // NAT64
	if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
	if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
	if ((a & 0xff00) === 0xff00) return true; // multicast
	if (a === 0x2001 && b === 0x0db8) return true; // documentation
	return false;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata addresses. */
export function isPrivateIpAddress(value: string): boolean {
	const address = value.trim().replace(/^\[|\]$/g, "");
	const ipv4 = parseIpv4(address);
	if (ipv4 !== null) return isBlockedIpv4(ipv4);
	const ipv6 = parseIpv6(address);
	if (ipv6) return isBlockedIpv6(ipv6);
	return false;
}

export function isIpAddressLiteral(value: string): boolean {
	const address = value.trim().replace(/^\[|\]$/g, "");
	return parseIpv4(address) !== null || parseIpv6(address) !== null;
}

/** Literal check, without DNS: blocked names and private IP literals. */
export function isBlockedHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!host) return true;
	if (BLOCKED_HOSTNAMES.has(host)) return true;
	if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
	if (isIpAddressLiteral(host)) return isPrivateIpAddress(host);
	// A bare name without a dot only resolves through local search domains.
	return !host.includes(".");
}

export class OutboundUrlError extends Error {}

/** Parses a user-supplied http(s) URL and rejects private destinations it names literally. */
export function parsePublicHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OutboundUrlError("Enter a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new OutboundUrlError("Only http and https URLs are allowed");
	if (url.username || url.password) throw new OutboundUrlError("URLs with credentials are not allowed");
	if (isBlockedHost(url.hostname)) throw new OutboundUrlError("Private and local addresses are not allowed");
	return url;
}

export function isPublicHttpUrl(value: string): boolean {
	try {
		parsePublicHttpUrl(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * The literal check plus, where the runtime can resolve names (the Node server
 * provides `RESOLVE_HOST`), a check of every address the name resolves to.
 * Workers cannot reach private networks, so the literal check is enough there.
 */
export async function assertPublicHttpUrl(env: Pick<CloudflareEnv, "RESOLVE_HOST">, value: string): Promise<URL> {
	const url = parsePublicHttpUrl(value);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (env.RESOLVE_HOST && !isIpAddressLiteral(hostname)) {
		const addresses = await env.RESOLVE_HOST(hostname).catch(() => {
			throw new OutboundUrlError(`Could not resolve ${hostname}`);
		});
		if (!addresses.length) throw new OutboundUrlError(`Could not resolve ${hostname}`);
		if (addresses.some(isPrivateIpAddress)) throw new OutboundUrlError("Private and local addresses are not allowed");
	}
	return url;
}
