/**
 * A TCP connection to a mail server, in the shape of `connect()` from `cloudflare:sockets`, so one IMAP or SMTP
 * client runs on Workers and on the Node server (`server/runtime/tcp-connect.ts`).
 */
export type MailSocket = {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	/** Resolves once the connection (and, for `secureTransport: "on"`, the TLS handshake) is up; rejects when it fails. */
	readonly opened: Promise<unknown>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
	/** Upgrades a `secureTransport: "starttls"` connection; the returned socket replaces this one. */
	startTls(): MailSocket;
};

export type TcpConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: "on" | "starttls"; allowHalfOpen: false },
) => MailSocket;

/** Implicit TLS (IMAP 993, SMTP 465) or a STARTTLS upgrade (IMAP 143, SMTP 587). There is no plain-text mode. */
export type MailSocketSecurity = "tls" | "starttls";

export type MailServerTarget = { host: string; port: number; security: MailSocketSecurity };

/**
 * Node server only (`env.PINNED_POST`, `server/runtime/pinned-post.ts`): POSTs a small body to a public http(s) URL,
 * resolving the name itself, refusing it when any address is private and connecting only to the addresses it
 * checked, so a DNS answer cannot change between the check and the connection. Never follows a redirect; answers
 * the status, never the body. Rejects with `OutboundUrlError` for a refused host.
 */
export type PinnedPost = (
	url: string,
	init: { body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number }>;
