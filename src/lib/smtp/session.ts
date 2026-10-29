import { openMailSocket } from "@/lib/net/connect";
import { MailServerRefusedError } from "@/lib/net/errors";
import { allowsPlainText, mailHostPolicy } from "@/lib/net/host-guard-utils";
import { SmtpConnection, type SmtpConnectionOptions } from "./connection";
import { SmtpMessageTooLargeError } from "./errors";
import {
	assertCredential,
	base64Utf8,
	chooseSmtpAuthMethod,
	hasEightBitBytes,
	parseEhloExtensions,
	planSmtpStartTls,
	SMTP_CLIENT_NAME,
	SMTP_PORTS,
	smtpPlainToken,
	transportAddress,
} from "./protocol-utils";
import type { SmtpEnvelope, SmtpExtensions, SmtpLogin } from "./types";

/** Called between the last RCPT TO and DATA; throwing stops the send there (after RSET), before any message byte. */
export type SmtpSendHooks = { beforeData?: () => Promise<void> };

export type SmtpSession = {
	/** What the server announced after TLS and before sign-in. */
	readonly extensions: SmtpExtensions;
	/**
	 * Sends one message: `MAIL FROM`, one `RCPT TO` per recipient, `DATA` and the dot-stuffed bytes. Any refused
	 * recipient fails the whole message (after `RSET`), so a send never reaches only some of its recipients. Resolves
	 * with the server's final reply text (often its queue id). Rejects with `SmtpReplyError` when the server refuses a
	 * step (`retryable` for 4xx), and with `SmtpDeliveryUnknownError` (never retryable) when the connection fails once the
	 * message is on its way: the caller must not send it again automatically.
	 */
	send(envelope: SmtpEnvelope, raw: Uint8Array, hooks?: SmtpSendHooks): Promise<{ response: string }>;
	close(): Promise<void>;
};

type SmtpEnv = Parameters<typeof openMailSocket>[0];

/** How long `close()` waits for the answer to QUIT. */
const QUIT_TIMEOUT_MS = 5_000;

/**
 * Connects to a submission server, makes sure the connection is encrypted (implicit TLS on 465, or STARTTLS on 587
 * before anything else is sent) and signs in with `AUTH PLAIN` or `AUTH LOGIN`. Credentials never go over a plain
 * connection, except to a loopback fake under `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK` outside production. Errors
 * never contain the password.
 */
export async function openSmtpSession(
	env: SmtpEnv,
	login: SmtpLogin,
	options: SmtpConnectionOptions = {},
): Promise<SmtpSession> {
	assertCredential(login.username, login.password);
	const socket = await openMailSocket(env, login, SMTP_PORTS);
	const smtp = new SmtpConnection(socket, options);
	let extensions: SmtpExtensions;
	try {
		extensions = await signIn(smtp, login, allowsPlainText(login.host, mailHostPolicy(env, process.env.NODE_ENV)));
	} catch (error) {
		await smtp.close();
		throw error;
	}
	return {
		extensions,
		send: (envelope, raw, hooks) => sendMessage(smtp, extensions, envelope, raw, hooks),
		async close() {
			// A polite goodbye only: the message is already queued, so a server slow to answer QUIT is not waited for.
			await smtp.command("QUIT", "data", [221], { timeoutMs: QUIT_TIMEOUT_MS }).catch(() => undefined);
			await smtp.close();
		},
	};
}

/** Opens a session, sends one message and closes the session again, whatever happened. */
export async function submitMessage(
	env: SmtpEnv,
	login: SmtpLogin,
	envelope: SmtpEnvelope,
	raw: Uint8Array,
	options: SmtpConnectionOptions = {},
	hooks: SmtpSendHooks = {},
): Promise<{ response: string }> {
	const session = await openSmtpSession(env, login, options);
	try {
		return await session.send(envelope, raw, hooks);
	} finally {
		await session.close();
	}
}

async function signIn(smtp: SmtpConnection, login: SmtpLogin, plainTextAllowed: boolean): Promise<SmtpExtensions> {
	await smtp.greeting();
	let extensions = parseEhloExtensions(await smtp.command(`EHLO ${SMTP_CLIENT_NAME}`, "ehlo", [250]));
	const plan = planSmtpStartTls({ security: login.security, extensions, plainTextAllowed });
	if (plan.action === "refuse") throw new MailServerRefusedError(plan.reason);
	if (plan.action === "starttls") {
		await smtp.startTls();
		// What was announced before the upgrade is not trustworthy (RFC 3207 §4.2).
		extensions = parseEhloExtensions(await smtp.command(`EHLO ${SMTP_CLIENT_NAME}`, "ehlo", [250]));
	}
	const method = chooseSmtpAuthMethod(extensions.auth);
	if (!method) throw new MailServerRefusedError("The SMTP server does not accept a password sign-in");
	const secrets = [login.password, smtpPlainToken(login.username, login.password)];
	if (method === "plain") {
		await smtp.command(`AUTH PLAIN ${smtpPlainToken(login.username, login.password)}`, "auth", [235], { secrets });
	} else {
		await smtp.command("AUTH LOGIN", "auth", [334], { secrets });
		await smtp.command(base64Utf8(login.username), "auth", [334], { secrets });
		await smtp.command(base64Utf8(login.password), "auth", [235], { secrets });
	}
	return extensions;
}

async function sendMessage(
	smtp: SmtpConnection,
	extensions: SmtpExtensions,
	envelope: SmtpEnvelope,
	raw: Uint8Array,
	hooks: SmtpSendHooks = {},
): Promise<{ response: string }> {
	const from = transportAddress(envelope.from);
	const seen = new Set<string>();
	const recipients = envelope.recipients
		.map(transportAddress)
		.filter((address) => !seen.has(address.toLowerCase()) && !!seen.add(address.toLowerCase()));
	if (!recipients.length) throw new Error("The message has no recipients");
	if (extensions.size !== null && raw.byteLength > extensions.size)
		throw new SmtpMessageTooLargeError(raw.byteLength, extensions.size);
	const eightBit = hasEightBitBytes(raw);
	// Kite's own messages are 7-bit (`buildMimeMessage`); 8-bit bytes go only to a server that announced 8BITMIME.
	if (eightBit && !extensions.keywords.includes("8BITMIME"))
		throw new Error("The message has 8-bit content and the SMTP server does not accept it (no 8BITMIME)");
	const params = [
		...(extensions.keywords.includes("SIZE") ? [`SIZE=${raw.byteLength}`] : []),
		...(eightBit ? ["BODY=8BITMIME"] : []),
	];
	try {
		await smtp.command([`MAIL FROM:<${from}>`, ...params].join(" "), "mail", [250]);
		for (const recipient of recipients) await smtp.command(`RCPT TO:<${recipient}>`, "rcpt", [250, 251], { recipient });
		await hooks.beforeData?.();
		await smtp.command("DATA", "data", [354]);
	} catch (error) {
		// Leave the session clean for another message; a failure here only matters to this one.
		await smtp.command("RSET", "mail", [250]).catch(() => undefined);
		throw error;
	}
	const reply = await smtp.sendData(raw);
	return { response: reply.lines.join(" ").trim() };
}
