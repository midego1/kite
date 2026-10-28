import { isBlockedHost, isIpAddressLiteral, isPrivateIpAddress } from "@/lib/security/outbound-url";

/** The ports mail servers listen on: IMAP 993 and 143, SMTP submission 465 and 587. */
export const MAIL_SERVER_PORTS = [993, 143, 465, 587] as const;

/** What the mail server guard lets through beyond public hosts on the mail ports. */
export type MailHostPolicy = {
	/** `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK`, outside production: loopback hosts on any port, without TLS (the fakes). */
	allowInsecureLoopback: boolean;
	/**
	 * `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS`, Node server only: LAN mail servers (RFC 1918 and IPv6 unique local
	 * addresses), still over TLS. Loopback, link-local (the metadata address) and 0.0.0.0/8 stay refused.
	 */
	allowPrivate: boolean;
	/** `EXTERNAL_ACCOUNTS_EXTRA_PORTS`, Node server only: ports beyond the mail ports (DavMail, Proton Bridge). */
	extraPorts: number[];
};

const isOn = (flag: string | undefined) => flag === "1" || flag === "true";

/** @public Exercised by the unit tests. A comma-separated list of ports; anything that is not a port number is ignored. */
export function parsePortList(value: string | undefined): number[] {
	const ports = (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => /^\d{1,5}$/.test(part))
		.map(Number)
		.filter((port) => port >= 1 && port <= 65535);
	return [...new Set(ports)];
}

/**
 * The loopback flag is ignored in production, like `AI_ALLOW_INSECURE_LOOPBACK`. The private-host and extra-port
 * settings are honoured only by the Node server: a Worker's `connect()` egresses from Cloudflare and cannot reach the
 * operator's network, so Workers keep the strict mail ports.
 */
export function mailHostPolicy(
	env: Partial<
		Pick<
			CloudflareEnv,
			| "EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK"
			| "EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS"
			| "EXTERNAL_ACCOUNTS_EXTRA_PORTS"
			| "KITE_RUNTIME"
		>
	>,
	nodeEnv: string | undefined,
): MailHostPolicy {
	const node = env.KITE_RUNTIME === "node";
	return {
		allowInsecureLoopback: isOn(env.EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK) && nodeEnv !== "production",
		allowPrivate: isOn(env.EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS) && node,
		extraPorts: node ? parsePortList(env.EXTERNAL_ACCOUNTS_EXTRA_PORTS) : [],
	};
}

/**
 * The host as a connection would see it: trimmed, lower-case, without brackets or a trailing dot, and with IPv4
 * shorthands (`127.1`, `0177.0.0.1`, `0x7f.0.0.1`, `2130706433`) turned into dotted quads by the WHATWG URL parser,
 * so a literal check cannot be dodged by spelling an address differently. Null when it is not a valid host.
 */
export function canonicalMailHost(host: string): string | null {
	const value = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!value) return null;
	if (value.includes(":")) return isIpAddressLiteral(value) ? value : null;
	try {
		const url = new URL(`http://${value}/`);
		const bare = !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
		return bare && url.hostname ? url.hostname : null;
	} catch {
		return null;
	}
}

export function isLoopbackHost(host: string): boolean {
	const value = canonicalMailHost(host);
	if (!value) return false;
	return (
		value === "localhost" ||
		value.endsWith(".localhost") ||
		value === "::1" ||
		(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) && isPrivateIpAddress(value))
	);
}

/**
 * The private addresses `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS` opens: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and
 * IPv6 unique local fc00::/7. Never loopback, link-local, CGNAT, 0.0.0.0/8 or mapped forms.
 */
export function isLanAddress(address: string): boolean {
	const value = canonicalMailHost(address);
	if (!value || !isIpAddressLiteral(value)) return false;
	const quad = value.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (quad) {
		const [a, b] = [Number(quad[1]), Number(quad[2])];
		return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}
	const first = value.split(":")[0];
	return /^f[cd][0-9a-f]{2}$/.test(first.padStart(4, "0"));
}

/** True when the connection may go on without TLS: only to a loopback host, only under the dev flag. */
export function allowsPlainText(host: string, policy: Pick<MailHostPolicy, "allowInsecureLoopback">): boolean {
	return policy.allowInsecureLoopback && isLoopbackHost(host);
}

/**
 * Whether the private-host setting lets this host through the literal check: a LAN address literal, or a name the
 * Node connector will resolve and check address by address. Loopback names stay refused.
 */
function isAllowedPrivateHost(host: string): boolean {
	if (isLoopbackHost(host)) return false;
	return isIpAddressLiteral(host) ? isLanAddress(host) : true;
}

/**
 * The literal half of the guard, checked before every connection: why Kite refuses to connect to `host:port`, or
 * null. The Node connector also checks every address the name resolves to (`server/runtime/tcp-connect.ts`).
 */
export function mailServerHostProblem(
	host: string,
	port: number,
	policy: MailHostPolicy,
	ports: readonly number[] = MAIL_SERVER_PORTS,
): string | null {
	if (!host.trim()) return "Enter the mail server name";
	const canonical = canonicalMailHost(host);
	if (!canonical) return "The mail server name is invalid";
	if (!Number.isInteger(port) || port < 1 || port > 65535) return "The port is invalid";
	if (allowsPlainText(canonical, policy)) return null;
	if (isBlockedHost(canonical) && !(policy.allowPrivate && isAllowedPrivateHost(canonical)))
		return "Private and local mail servers are not allowed";
	const allowed = [...ports, ...policy.extraPorts.filter((extra) => !ports.includes(extra))];
	if (!allowed.includes(port))
		return `Port ${port} is not allowed; mail servers are reached on port ${listPorts(allowed)}`;
	return null;
}

function listPorts(ports: readonly number[]): string {
	return ports.length > 1 ? `${ports.slice(0, -1).join(", ")} or ${ports[ports.length - 1]}` : String(ports[0]);
}
