import { openMailSocket } from "@/lib/net/connect";
import { MailServerRefusedError } from "@/lib/net/errors";
import { allowsPlainText, mailHostPolicy } from "@/lib/net/host-guard-utils";
import { ImapConnection } from "./connection";
import {
	chooseAuthMethod,
	IMAP_PORTS,
	parseListMailboxName,
	parseSearchUids,
	plainAuthToken,
	planStartTls,
	quoteImapString,
} from "./protocol-utils";
import type { ImapLogin } from "./types";

export type ImapSession = {
	/** Opens `folder` read-only. */
	examine(folder: string): Promise<void>;
	searchUids(): Promise<string[]>;
	fetchMessages(uids: string[]): Promise<Map<string, ArrayBuffer>>;
	listMailboxNames(): Promise<string[]>;
	close(): Promise<void>;
};

type ImapEnv = Parameters<typeof openMailSocket>[0];

/**
 * Connects, makes sure the connection is encrypted (implicit TLS, or STARTTLS before anything else is sent) and
 * signs in with `AUTHENTICATE PLAIN` or `LOGIN`. Credentials are never sent over a plain connection, except to a
 * loopback fake under `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK` outside production.
 */
export async function openImapSession(env: ImapEnv, login: ImapLogin): Promise<ImapSession> {
	const socket = await openMailSocket(env, login, IMAP_PORTS);
	const imap = new ImapConnection(socket);
	try {
		await signIn(imap, login, allowsPlainText(login.host, mailHostPolicy(env, process.env.NODE_ENV)));
	} catch (error) {
		await imap.close();
		throw error;
	}
	return {
		async examine(folder) {
			await imap.command(`EXAMINE ${quoteImapString(folder)}`);
		},
		async searchUids() {
			const lines = await imap.command("UID SEARCH ALL");
			return lines.flatMap(parseSearchUids);
		},
		fetchMessages: (uids) => imap.fetchMessages(uids),
		async listMailboxNames() {
			const lines = await imap.command('LIST "" "*"');
			return Array.from(new Set(lines.map(parseListMailboxName).filter((name): name is string => !!name)));
		},
		async close() {
			await imap.command("LOGOUT").catch(() => undefined);
			await imap.close();
		},
	};
}

async function signIn(imap: ImapConnection, login: ImapLogin, plainTextAllowed: boolean): Promise<void> {
	const preauth = await imap.readGreeting();
	const capabilities = imap.capabilities.length ? imap.capabilities : await imap.capability();
	const plan = planStartTls({ security: login.security, capabilities, preauth, plainTextAllowed });
	if (plan.action === "refuse") throw new MailServerRefusedError(plan.reason);
	if (plan.action === "starttls") {
		await imap.startTls();
		await imap.capability();
	}
	if (preauth) return;
	const method = chooseAuthMethod(imap.capabilities);
	if (!method) throw new MailServerRefusedError("The IMAP server does not accept a password sign-in");
	if (method === "login") {
		await imap.command(
			`LOGIN ${quoteImapString(login.username)} ${quoteImapString(login.password)}`,
			"IMAP sign-in failed",
		);
		return;
	}
	await imap.authenticatePlain(plainAuthToken(login.username, login.password), method === "plain-ir");
}
