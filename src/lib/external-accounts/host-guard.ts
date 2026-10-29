import { MailServerRefusedError } from "@/lib/net/errors";
import { allowsPlainText, isLanAddress, mailHostPolicy, mailServerHostProblem } from "@/lib/net/host-guard-utils";
import { isIpAddressLiteral, isPrivateIpAddress } from "@/lib/security/outbound-url";

type GuardEnv = Parameters<typeof mailHostPolicy>[0] & Pick<CloudflareEnv, "RESOLVE_HOST">;

/**
 * Refuses a mail server Kite must not connect to (spec §11.2), when an account is saved and before it is tested:
 * private, local and bare names, ports other than 143, 993, 465 and 587, and, on the Node server (which resolves
 * names itself through `env.RESOLVE_HOST`), a name any of whose addresses is private. Every connection is checked
 * again by `openMailSocket`, and the Node connector pins the address it checked.
 */
export async function assertMailServerHost(env: GuardEnv, host: string, port: number): Promise<void> {
	const policy = mailHostPolicy(env, process.env.NODE_ENV);
	const problem = mailServerHostProblem(host, port, policy);
	if (problem) throw new MailServerRefusedError(problem);
	if (!env.RESOLVE_HOST || allowsPlainText(host, policy) || isIpAddressLiteral(host.trim())) return;
	let addresses: string[];
	try {
		addresses = await env.RESOLVE_HOST(host.trim());
	} catch {
		throw new MailServerRefusedError(`Kite could not find the mail server ${host.trim()}`);
	}
	if (!addresses.length) throw new MailServerRefusedError(`Kite could not find the mail server ${host.trim()}`);
	const refused = addresses.some(
		(address) => isPrivateIpAddress(address) && !(policy.allowPrivate && isLanAddress(address)),
	);
	if (refused) throw new MailServerRefusedError("Private and local mail servers are not allowed");
}
