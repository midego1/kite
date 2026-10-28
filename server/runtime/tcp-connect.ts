import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { MailServerRefusedError } from "../../src/lib/net/errors";
import { isLoopbackHost } from "../../src/lib/net/host-guard-utils";
import type { MailSocket, TcpConnect } from "../../src/lib/net/types";
import { isPrivateIpAddress } from "../../src/lib/security/outbound-url";

export type TcpConnectOptions = {
	/** Every address of a name; the default is `dns.lookup` with `all: true`. */
	resolve?: (hostname: string) => Promise<string[]>;
	/** `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS`: private and LAN addresses are allowed. */
	allowPrivate?: boolean;
	/** `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK` outside production: loopback addresses are allowed. */
	allowLoopback?: boolean;
	/** Tests only: a CA to trust for the fake server's certificate. Never read from the environment. */
	ca?: string;
	/** Per address tried. */
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
};

const CONNECT_TIMEOUT_MS = 15_000;
/** Addresses tried per connection, so a name with a long answer cannot hold a job for minutes. */
const MAX_ADDRESSES_TRIED = 4;
const IDLE_TIMEOUT_MS = 120_000;

async function resolveAll(hostname: string): Promise<string[]> {
	return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * The Node server's `env.TCP_CONNECT`. It resolves the host itself, refuses the connection when any address is
 * private (unless a flag allows it), and connects only to those vetted addresses, so a DNS answer cannot change between
 * the check and the connection. TLS uses the host name for SNI and certificate checks, and `rejectUnauthorized` is
 * always on.
 */
export function createTcpConnect(options: TcpConnectOptions = {}): TcpConnect {
	const resolve = options.resolve ?? resolveAll;
	return (address, connectOptions) => {
		const socket = new NodeMailSocket();
		socket.attach(
			(async () => {
				const targets = await vetAddresses(address.hostname, resolve, options);
				return connectFirst(address.hostname, targets, address.port, connectOptions.secureTransport === "on", options);
			})(),
			connectOptions.secureTransport === "starttls" ? (raw) => upgradeNodeSocket(raw, address.hostname, options) : null,
		);
		return socket;
	};
}

async function vetAddresses(
	hostname: string,
	resolve: (hostname: string) => Promise<string[]>,
	options: TcpConnectOptions,
): Promise<string[]> {
	const host = hostname.replace(/^\[|\]$/g, "");
	let addresses: string[];
	if (isIP(host)) addresses = [host];
	else {
		addresses = await resolve(host).catch(() => []);
		if (!addresses.length) throw new Error(`Could not resolve ${host}`);
	}
	const allowed = (value: string) =>
		!isPrivateIpAddress(value) || options.allowPrivate || (options.allowLoopback && isLoopbackHost(value));
	if (!addresses.every(allowed)) throw new MailServerRefusedError("Private and local mail servers are not allowed");
	return addresses.slice(0, MAX_ADDRESSES_TRIED);
}

/**
 * Tries the vetted addresses in the resolver's order until one answers, so a name with an unreachable IPv6 address
 * (a container without IPv6) still connects over IPv4. Only checked addresses are ever dialled, and a certificate
 * problem is final: another address of the same name would present the same certificate.
 */
async function connectFirst(
	hostname: string,
	addresses: string[],
	port: number,
	secure: boolean,
	options: TcpConnectOptions,
): Promise<Socket> {
	let lastError: unknown = null;
	for (const address of addresses) {
		try {
			return await openNodeSocket(hostname, address, port, secure, options);
		} catch (error) {
			if (isCertificateError(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

function isCertificateError(error: unknown): boolean {
	const code = String((error as { code?: unknown } | null)?.code ?? "");
	return /CERT|SELF_SIGNED|ERR_TLS/.test(code) || (error instanceof Error && /certificate/i.test(error.message));
}

/** Node checks the certificate against `servername`, else `host`: the name the user entered, never the address. */
function tlsOptions(hostname: string, options: TcpConnectOptions) {
	const host = hostname.replace(/^\[|\]$/g, "");
	return {
		// SNI must be a name; an IP literal is checked as the host itself.
		...(isIP(host) ? { host } : { servername: host }),
		rejectUnauthorized: true,
		...(options.ca ? { ca: options.ca } : {}),
	};
}

function openNodeSocket(
	hostname: string,
	address: string,
	port: number,
	secure: boolean,
	options: TcpConnectOptions,
): Promise<Socket> {
	return new Promise((resolvePromise, reject) => {
		const socket: Socket = secure
			? tlsConnect({ ...tlsOptions(hostname, options), host: address, port })
			: netConnect({ host: address, port });
		const timer = setTimeout(
			() => socket.destroy(new Error("Timed out connecting to the mail server")),
			options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
		);
		const fail = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once("error", fail);
		socket.once(secure ? "secureConnect" : "connect", () => {
			clearTimeout(timer);
			socket.off("error", fail);
			socket.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () =>
				socket.destroy(new Error("The mail server stopped responding")),
			);
			resolvePromise(socket);
		});
	});
}

function upgradeNodeSocket(raw: Socket, hostname: string, options: TcpConnectOptions): Promise<Socket> {
	return new Promise((resolvePromise, reject) => {
		raw.setTimeout(0);
		const secure: TLSSocket = tlsConnect({ socket: raw, ...tlsOptions(hostname, options) });
		const fail = (error: Error) => reject(error);
		secure.once("error", fail);
		secure.once("secureConnect", () => {
			secure.off("error", fail);
			secure.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () =>
				secure.destroy(new Error("The mail server stopped responding")),
			);
			resolvePromise(secure);
		});
	});
}

/**
 * Web streams over a Node socket that can be detached again, which `startTls()` needs: the TLS socket takes over the
 * raw one, so this wrapper stops reading it and closes its own streams. (`Duplex.toWeb` cannot be detached.)
 */
class NodeMailSocket implements MailSocket {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	readonly opened: Promise<unknown>;
	readonly closed: Promise<void>;
	/** Set by `attach`, right after construction. */
	private socket!: Promise<Socket>;
	private upgrade: ((raw: Socket) => Promise<Socket>) | null = null;
	private detach: (() => void) | null = null;
	private readController!: ReadableStreamDefaultController<Uint8Array>;
	private resolveOpened!: (value: unknown) => void;
	private rejectOpened!: (error: unknown) => void;
	private resolveClosed!: () => void;
	private done = false;

	constructor() {
		this.opened = new Promise((resolve, reject) => {
			this.resolveOpened = resolve;
			this.rejectOpened = reject;
		});
		this.opened.catch(() => undefined);
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		this.readable = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.readController = controller;
				},
				pull: async () => {
					(await this.socket.catch(() => null))?.resume();
				},
				cancel: () => this.close(),
			},
			{ highWaterMark: 4 },
		);
		this.writable = new WritableStream<Uint8Array>({
			write: async (chunk) => {
				const socket = await this.socket;
				if (this.done) throw new Error("The connection to the mail server is closed");
				await new Promise<void>((resolve, reject) =>
					socket.write(chunk, (error) => (error ? reject(error) : resolve())),
				);
			},
			close: async () => {
				(await this.socket.catch(() => null))?.end();
			},
			abort: () => this.close(),
		});
	}

	attach(socket: Promise<Socket>, upgrade: ((raw: Socket) => Promise<Socket>) | null): void {
		this.socket = socket;
		this.upgrade = upgrade;
		socket.then(
			(connected) => {
				this.listen(connected);
				this.resolveOpened({});
			},
			(error) => {
				this.rejectOpened(error);
				this.finish(error);
			},
		);
	}

	private listen(socket: Socket): void {
		const onData = (chunk: Buffer) => {
			if (this.done) return;
			this.readController.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			if ((this.readController.desiredSize ?? 1) <= 0) socket.pause();
		};
		const onEnd = () => this.finish();
		const onError = (error: Error) => this.finish(error);
		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("close", onEnd);
		socket.once("error", onError);
		this.detach = () => {
			socket.off("data", onData);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			socket.off("error", onError);
			// A late error on a detached socket must not become an uncaught exception.
			socket.on("error", () => undefined);
			socket.pause();
		};
	}

	private finish(error?: Error): void {
		if (this.done) return;
		this.done = true;
		this.detach?.();
		this.detach = null;
		try {
			if (error) this.readController.error(error);
			else this.readController.close();
		} catch {
			// The stream was already closed or cancelled.
		}
		this.resolveClosed();
	}

	async close(): Promise<void> {
		const socket = await this.socket.catch(() => null);
		this.finish();
		socket?.destroy();
	}

	startTls(): MailSocket {
		const upgrade = this.upgrade;
		if (!upgrade) throw new Error("This connection was not opened for STARTTLS");
		this.upgrade = null;
		const next = new NodeMailSocket();
		const raw = this.socket.then((socket) => {
			this.detach?.();
			this.detach = null;
			this.finish();
			return upgrade(socket);
		});
		next.attach(raw, null);
		return next;
	}
}
