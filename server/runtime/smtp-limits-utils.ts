/**
 * Limits of the inbound SMTP listener (upstream Mailflare #215), kept apart from `smtp.ts` so they can be tested
 * without a socket.
 */
export const SMTP_INGRESS_LIMITS = {
	/** Open sessions in total. */
	maxClients: 100,
	/** Open sessions from one address. */
	maxSessionsPerIp: 10,
	/** Envelope recipients of one message; the next new RCPT TO gets 452, so the sender retries the rest later. */
	maxRecipients: 50,
	/** A session idle this long is closed. */
	socketTimeoutMs: 60_000,
} as const;

export type SmtpResponseError = Error & { responseCode: number };

export function smtpResponseError(message: string, responseCode: number): SmtpResponseError {
	return Object.assign(new Error(message), { responseCode });
}

/**
 * Admitted sessions, per address and in total. Only an admitted session is released on close, so a refused one
 * cannot lower another session's count. smtp-server's own `maxClients` lets one connection past the limit, which is
 * why the total is enforced here too.
 */
export function createSessionLimiter(limits: { maxClients: number; maxSessionsPerIp: number } = SMTP_INGRESS_LIMITS) {
	const perIp = new Map<string, number>();
	const admitted = new Map<string, string>();
	return {
		/** Admits the session, or returns false when the address or the server is at its limit. */
		admit(sessionId: string, ip: string): boolean {
			const count = perIp.get(ip) ?? 0;
			if (admitted.has(sessionId)) return true;
			if (count >= limits.maxSessionsPerIp || admitted.size >= limits.maxClients) return false;
			admitted.set(sessionId, ip);
			perIp.set(ip, count + 1);
			return true;
		},
		release(sessionId: string): void {
			const ip = admitted.get(sessionId);
			if (ip === undefined) return;
			admitted.delete(sessionId);
			const count = (perIp.get(ip) ?? 1) - 1;
			if (count <= 0) perIp.delete(ip);
			else perIp.set(ip, count);
		},
		get size(): number {
			return admitted.size;
		},
		sessionsFrom(ip: string): number {
			return perIp.get(ip) ?? 0;
		},
	};
}

/**
 * Collects a message's DATA up to `maxSize` bytes. Past that it only counts, so an oversized message is not held in
 * memory while the sender finishes; the listener answers 552 at the end.
 */
export function createDataCollector(maxSize: number) {
	const chunks: Buffer[] = [];
	let received = 0;
	return {
		push(chunk: Buffer): void {
			received += chunk.length;
			if (received <= maxSize) chunks.push(chunk);
			else chunks.length = 0;
		},
		get exceeded(): boolean {
			return received > maxSize;
		},
		get received(): number {
			return received;
		},
		/** The buffered message; empty once over the limit. */
		buffer(): Buffer {
			return Buffer.concat(chunks);
		},
	};
}
