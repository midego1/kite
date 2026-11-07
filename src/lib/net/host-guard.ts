import { MailServerRefusedError } from "./errors";
import {
	allowsPlainText,
	canonicalMailHost,
	isLanAddress,
	mailHostPolicy,
	MAIL_SERVER_PORTS,
	mailServerHostProblem,
} from "./host-guard-utils";
import { isIpAddressLiteral, isPrivateIpAddress } from "@/lib/security/outbound-url";

type GuardEnv = Parameters<typeof mailHostPolicy>[0] & Pick<CloudflareEnv, "RESOLVE_HOST">;

/**
 * Refuses a mail server Kite must not connect to (external accounts spec §11.2), when a connected account or an import
 * job is saved and before it is tested: private, local and bare names, ports other than `ports` (143, 993, 465 and 587
 * unless given), and, on the Node server (which resolves names itself through `env.RESOLVE_HOST`), a name any of whose
 * addresses is private. So a private name is refused when it is entered, not only at the first sync or run. Every
 * connection is checked again by `openMailSocket`, and the Node connector resolves again and pins the address it
 * checked, so a name that starts resolving to a private address later is still refused.
 */
export async function assertMailServerHost(
	env: GuardEnv,
	host: string,
	port: number,
	ports: readonly number[] = MAIL_SERVER_PORTS,
): Promise<void> {
	const policy = mailHostPolicy(env, process.env.NODE_ENV);
	const problem = mailServerHostProblem(host, port, policy, ports);
	if (problem) throw new MailServerRefusedError(problem);
	// The form the literal check passed and the connector dials (`0x0a.1.` is `10.0.0.1`), never the text as typed.
	const name = canonicalMailHost(host) ?? host.trim();
	if (!env.RESOLVE_HOST || allowsPlainText(name, policy) || isIpAddressLiteral(name)) return;
	let addresses: string[];
	try {
		addresses = await env.RESOLVE_HOST(name);
	} catch {
		throw new MailServerRefusedError(`Kite could not find the mail server ${name}`);
	}
	if (!addresses.length) throw new MailServerRefusedError(`Kite could not find the mail server ${name}`);
	const refused = addresses.some(
		(address) => isPrivateIpAddress(address) && !(policy.allowPrivate && isLanAddress(address)),
	);
	if (refused) throw new MailServerRefusedError("Private and local mail servers are not allowed");
}
