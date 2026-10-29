import { openImapSession } from "@/lib/imap/session";
import type { ImapLogin } from "@/lib/imap/types";
import { MailServerRefusedError } from "@/lib/net/errors";
import { openSmtpSession } from "@/lib/smtp/session";
import type { SmtpLogin } from "@/lib/smtp/types";
import { classifyConnectionError, type ConnectionProblem } from "./connection-utils";

type TestEnv = Parameters<typeof openImapSession>[0];

/** The INBOX baseline a successful test reads: new-mail checks start after `uidNext − 1`. */
export type ImapBaseline = { uidValidity: number | null; uidNext: number | null };

export type ConnectionTestResult = { ok: true; baseline: ImapBaseline } | { ok: false; problem: ConnectionProblem };

/**
 * Signs in to the account's IMAP server over TLS (or STARTTLS before anything else is sent) and opens INBOX
 * read-only, which proves the credentials and reads the baseline. Nothing at the source changes.
 */
export async function testImapConnection(env: TestEnv, login: ImapLogin): Promise<ConnectionTestResult> {
	let session: Awaited<ReturnType<typeof openImapSession>> | null = null;
	try {
		session = await openImapSession(env, login);
		const inbox = await session.examine("INBOX");
		return { ok: true, baseline: inbox };
	} catch (error) {
		return {
			ok: false,
			problem: classifyConnectionError(error, {
				refused: error instanceof MailServerRefusedError,
				secrets: [login.password],
			}),
		};
	} finally {
		await session?.close().catch(() => undefined);
	}
}

export type SmtpTestResult = { ok: true } | { ok: false; problem: ConnectionProblem };

/**
 * Signs in to the account's SMTP submission server (TLS, or STARTTLS before any credential) and says goodbye without
 * sending anything. A success makes the login address a send-as identity (spec §7.2).
 */
export async function testSmtpConnection(env: TestEnv, login: SmtpLogin): Promise<SmtpTestResult> {
	try {
		const session = await openSmtpSession(env, login);
		await session.close();
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			problem: classifyConnectionError(error, {
				refused: error instanceof MailServerRefusedError,
				secrets: [login.password],
			}),
		};
	}
}
