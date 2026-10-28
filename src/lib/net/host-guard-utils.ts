import { isBlockedHost, isPrivateIpAddress } from "@/lib/security/outbound-url";

/** The ports mail servers listen on: IMAP 993 and 143, SMTP submission 465 and 587. */
export const MAIL_SERVER_PORTS = [993, 143, 465, 587] as const;

/** What the mail server guard lets through beyond public hosts on the mail ports. */
export type MailHostPolicy = {
	/** `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK`, outside production: loopback hosts on any port, without TLS (the fakes). */
	allowInsecureLoopback: boolean;
	/** `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS`, Node server only: private and LAN mail servers, still over TLS. */
	allowPrivate: boolean;
};

const isOn = (flag: string | undefined) => flag === "1" || flag === "true";

/**
 * The loopback flag is ignored in production, like `AI_ALLOW_INSECURE_LOOPBACK`. The private flag is honoured only by
 * the Node server: a Worker's `connect()` egresses from Cloudflare and cannot reach the operator's network.
 */
export function mailHostPolicy(
	env: Partial<
		Pick<
			CloudflareEnv,
			"EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK" | "EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS" | "KITE_RUNTIME"
		>
	>,
	nodeEnv: string | undefined,
): MailHostPolicy {
	return {
		allowInsecureLoopback: isOn(env.EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK) && nodeEnv !== "production",
		allowPrivate: isOn(env.EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS) && env.KITE_RUNTIME === "node",
	};
}

const normalizeHost = (host: string) =>
	host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");

export function isLoopbackHost(host: string): boolean {
	const value = normalizeHost(host);
	return (
		value === "localhost" ||
		value === "::1" ||
		(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) && isPrivateIpAddress(value))
	);
}

/** True when the connection may go on without TLS: only to a loopback host, only under the dev flag. */
export function allowsPlainText(host: string, policy: MailHostPolicy): boolean {
	return policy.allowInsecureLoopback && isLoopbackHost(host);
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
	if (!normalizeHost(host)) return "Enter the mail server name";
	if (!Number.isInteger(port) || port < 1 || port > 65535) return "The port is invalid";
	if (allowsPlainText(host, policy)) return null;
	if (isBlockedHost(normalizeHost(host)) && !policy.allowPrivate)
		return "Private and local mail servers are not allowed";
	if (!ports.includes(port)) return `Port ${port} is not allowed; mail servers are reached on port ${listPorts(ports)}`;
	return null;
}

function listPorts(ports: readonly number[]): string {
	return ports.length > 1 ? `${ports.slice(0, -1).join(", ")} or ${ports[ports.length - 1]}` : String(ports[0]);
}
