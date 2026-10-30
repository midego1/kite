import { readFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";
import type { SMTPServerSession } from "smtp-server";
import type { DNSResolver } from "mailauth";
import { getDb } from "@/db";
import { intakeIncomingMail } from "@/lib/email/intake";
import { resolveInboundAddress } from "@/lib/email/routing";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import type { Mailer } from "./mailer";
import { verifyPrivateClientAuthentication, verifySmtpAuthentication } from "./smtp-auth";
import {
	isPrivateClientAddress,
	smtpAuthservId,
	stripOwnAuthenticationResults,
	trustedReceivedHeader,
} from "./smtp-auth-utils";
import { createDataCollector, createSessionLimiter, SMTP_INGRESS_LIMITS, smtpResponseError } from "./smtp-limits-utils";

/**
 * Receive mail directly on port 25 (or wherever SMTP_INBOUND_PORT points).
 * One inbound connection per message; each envelope recipient is handed to
 * the same intake the Cloudflare handler uses. Rejected mail gets a 550
 * during DATA, so the sender sees the routing rule's reason. Sessions, recipients
 * and idle time are capped (`SMTP_INGRESS_LIMITS`), and SPF, DKIM and DMARC are
 * verified here (`smtp-auth.ts`), since no other hop saw the message.
 */
export function startSmtpListener(
	env: CloudflareEnv,
	mailer: Mailer,
	options: {
		port: number;
		host?: string;
		maxSize: number;
		hostname?: string;
		tls: { keyPath: string; certPath: string } | null;
		/** Replaces DNS for SPF, DKIM and DMARC verification (tests). */
		resolver?: DNSResolver;
		/** Verifies clients on private and loopback addresses too (tests). */
		verifyPrivateClients?: boolean;
	},
) {
	const authservId = smtpAuthservId(options.hostname);
	const sessions = createSessionLimiter();
	// STARTTLS is only offered with a real certificate; smtp-server's built-in
	// one has a public private key, and advertising it would mislead senders.
	const server = new SMTPServer({
		maxClients: SMTP_INGRESS_LIMITS.maxClients,
		socketTimeout: SMTP_INGRESS_LIMITS.socketTimeoutMs,
		// smtp-server answers 452 itself, before onRcptTo, and does not count a repeated address twice.
		maxRecipients: SMTP_INGRESS_LIMITS.maxRecipients,
		onConnect(session, callback) {
			callback(
				sessions.admit(session.id, session.remoteAddress) ? undefined : smtpResponseError("Too many connections", 421),
			);
		},
		onClose(session) {
			sessions.release(session.id);
		},
		name: options.hostname,
		authOptional: true,
		disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
		...(options.tls ? { key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) } : {}),
		size: options.maxSize,
		banner: "Kite",
		// Refuse recipients no domain, mailbox, alias or catch-all here would take, so the
		// listener never accepts mail it would drop or bounce later (backscatter).
		onRcptTo(address, _session, callback) {
			resolveInboundAddress(getDb(env), address.address).then(
				(decision) =>
					callback(decision ? undefined : Object.assign(new Error("No such recipient here"), { responseCode: 550 })),
				(error) => {
					console.error(`SMTP recipient lookup failed for ${address.address}`, error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
				},
			);
		},
		onData(stream, session: SMTPServerSession, callback) {
			const data = createDataCollector(options.maxSize);
			stream.on("data", (chunk: Buffer) => data.push(chunk));
			stream.on("end", async () => {
				if (stream.sizeExceeded || data.exceeded) {
					callback(smtpResponseError("Message exceeds size limit", 552));
					return;
				}
				const received = data.buffer();
				let attachmentLimitReason: string | null;
				try {
					attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(toArrayBuffer(received));
				} catch (error) {
					console.error("SMTP attachment inspection failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
					return;
				}
				if (attachmentLimitReason) {
					callback(Object.assign(new Error(attachmentLimitReason), { responseCode: 552 }));
					return;
				}
				const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				// No verifying hop saw this message, so any Authentication-Results in it are the sender's own.
				// Only the value verified here is passed on as trusted; null leaves authentication unknown. From a
				// private address (Docker's port proxy, a load balancer without PROXY protocol) SPF would fail for
				// every sender, so only DKIM is checked and DMARC reported only when it passes through DKIM; the
				// message records that its sender was not fully verified.
				const privateClient = !options.verifyPrivateClients && isPrivateClientAddress(session.remoteAddress);
				if (privateClient) warnPrivateClient(session.remoteAddress);
				const authenticationResults = privateClient
					? await verifyPrivateClientAuthentication(received, authservId, { resolver: options.resolver })
					: await verifySmtpAuthentication(
							received,
							{ ip: session.remoteAddress, helo: session.hostNameAppearsAs, sender: from, authservId },
							{ resolver: options.resolver },
						);
				const trace = trustedReceivedHeader({
					helo: session.hostNameAppearsAs,
					remoteAddress: session.remoteAddress,
					clientHostname: session.clientHostname,
					by: authservId,
					secure: session.secure,
					sessionId: session.id,
				});
				const raw = Buffer.concat([
					Buffer.from(`${trace}\r\n`, "latin1"),
					stripOwnAuthenticationResults(received, authservId),
				]);
				const headers = parseHeaders(raw);
				let rejectReason: string | null = null;
				for (const recipient of session.envelope.rcptTo) {
					const result = await intakeIncomingMail(
						env,
						{
							from,
							to: recipient.address,
							raw: toArrayBuffer(raw),
							headers,
							authenticationResults,
							...(privateClient ? { privateClient } : {}),
						},
						{
							reject: (reason) => {
								rejectReason = reason;
							},
							forward: async (destination) => mailer.sendRaw(from, destination, raw),
						},
					).catch((error) => {
						console.error(`SMTP intake failed for ${recipient.address}`, error);
						return null;
					});
					if (!result) {
						callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
						return;
					}
				}
				if (rejectReason) {
					callback(Object.assign(new Error(rejectReason), { responseCode: 550 }));
					return;
				}
				callback();
			});
		},
	});
	server.on("error", (error) => console.error("SMTP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => {
		console.log(`SMTP inbound listening on ${options.host ?? "0.0.0.0"}:${options.port}`);
	});
	return server;
}

let privateClientWarned = false;

/** Says once per process that sender checks are off because the listener does not see real client addresses. */
function warnPrivateClient(address: string): void {
	if (privateClientWarned) return;
	privateClientWarned = true;
	console.warn(
		`SMTP client connected from the private address ${address}: SPF is not checked for such clients, only DKIM. ` +
			"If senders reach this server from the internet, the listener is not seeing their real address (see docs/self-hosting.md).",
	);
}

/** Header map in the shape the Worker handler provides: lower-cased names, folded lines joined. */
export function parseHeaders(raw: Buffer): Record<string, string> {
	const text = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const name = line.slice(0, index).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(index + 1).trim();
	}
	return headers;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
