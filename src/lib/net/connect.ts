import { MailServerRefusedError } from "./errors";
import { mailHostPolicy, mailServerHostProblem, MAIL_SERVER_PORTS } from "./host-guard-utils";
import type { MailServerTarget, MailSocket, TcpConnect } from "./types";

async function cloudflareConnect(): Promise<TcpConnect> {
	try {
		// A computed name keeps bundlers from resolving the Workers-only module for the Node build.
		const moduleName = "cloudflare:sockets";
		const sockets = (await import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			moduleName
		)) as { connect: TcpConnect };
		return sockets.connect;
	} catch {
		throw new Error("This runtime cannot open connections to mail servers");
	}
}

/**
 * Opens a connection to a mail server through `env.TCP_CONNECT` (the Node server's connector, which pins the
 * resolved address) or `cloudflare:sockets` on Workers. Refuses private and local hosts and ports outside `ports`
 * first. TLS certificates are always verified; a `starttls` connection is plain until the client upgrades it.
 */
export async function openMailSocket(
	env: Pick<
		CloudflareEnv,
		| "TCP_CONNECT"
		| "EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK"
		| "EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS"
		| "KITE_RUNTIME"
	>,
	target: MailServerTarget,
	ports: readonly number[] = MAIL_SERVER_PORTS,
): Promise<MailSocket> {
	const problem = mailServerHostProblem(target.host, target.port, mailHostPolicy(env, process.env.NODE_ENV), ports);
	if (problem) throw new MailServerRefusedError(problem);
	const connect = env.TCP_CONNECT ?? (await cloudflareConnect());
	const socket = connect(
		{ hostname: target.host.trim(), port: target.port },
		{ secureTransport: target.security === "tls" ? "on" : "starttls", allowHalfOpen: false },
	);
	try {
		await socket.opened;
	} catch (error) {
		if (error instanceof MailServerRefusedError) throw error;
		const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
		throw new Error(`Could not connect to ${target.host}:${target.port}${reason}`);
	}
	return socket;
}
