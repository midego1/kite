import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { externalAccountFolders, externalAccounts } from "@/db/schema/external-accounts";
import { verifyPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import type { ImapLogin } from "@/lib/imap/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { MailServerRefusedError } from "@/lib/net/errors";
import { openSetting, SecretBoxError, sealSetting } from "@/lib/security/secret-box";
import { CONNECT_REFUSAL_TEXT, connectRefusal } from "./access";
import { auditExternalAccount, recordConnectionTest } from "./audit";
import { testImapConnection, type ImapBaseline } from "./connection-test";
import type { ConnectionProblem } from "./connection-utils";
import { ExternalAccountRefusal, externalAccountTablesReady } from "./errors";
import { assertMailServerHost } from "./host-guard";
import { AccountInputError, changesSignIn, parseAccountInput, passwordFrom } from "./input-utils";
import { addressDomain, findPreset, presetTrustsAuthResults } from "./presets-utils";
import { appendRecentError, serializeExternalAccount, type ExternalAccountRow } from "./serialize-utils";
import type { ExternalAccountInput, ExternalAccountView } from "./types";

/** The signed-in user a request acts for. */
export type AccountActor = { id: string; role: "admin" | "user"; passwordHash: string };

/** The answer to a connection test: the account as it is now, and what went wrong when it failed. */
export type AccountTestOutcome = { account: ExternalAccountView; problem: ConnectionProblem | null };

const problemStatus: Record<ConnectionProblem["kind"], ExternalAccountRow["status"] | null> = {
	auth: "auth_failed",
	tls: "tls_failed",
	refused: "error",
	// A server that does not answer may be back in a minute; the account keeps its state.
	unreachable: null,
};

export async function listExternalAccounts(env: CloudflareEnv, userId: string): Promise<ExternalAccountView[]> {
	const rows = await getDb(env)
		.select()
		.from(externalAccounts)
		.where(eq(externalAccounts.userId, userId))
		.orderBy(asc(externalAccounts.createdAt));
	return rows.map(serializeExternalAccount);
}

async function ownAccount(env: CloudflareEnv, userId: string, id: string): Promise<ExternalAccountRow> {
	if (!(await externalAccountTablesReady(env))) throw refusalFor("migration_pending");
	const [row] = await getDb(env)
		.select()
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, id), eq(externalAccounts.userId, userId)))
		.limit(1);
	// Another user's account answers like a missing one, so ids do not leak.
	if (!row) throw new ExternalAccountRefusal(404, "Account not found");
	return row;
}

function refusalFor(reason: keyof typeof CONNECT_REFUSAL_TEXT): ExternalAccountRefusal {
	const status = reason === "not_permitted" ? 403 : 409;
	return new ExternalAccountRefusal(status, CONNECT_REFUSAL_TEXT[reason], reason.toUpperCase());
}

async function assertAllowed(env: CloudflareEnv, userId: string): Promise<void> {
	const refusal = await connectRefusal(env, userId);
	if (refusal) throw refusalFor(refusal);
}

function assertKitePassword(actor: AccountActor, value: unknown): void {
	if (typeof value !== "string" || !value || !verifyPassword(value, actor.passwordHash))
		throw new ExternalAccountRefusal(400, "Your Kite password is incorrect", "KITE_PASSWORD");
}

function parse(body: unknown, current?: ExternalAccountView): ExternalAccountInput {
	try {
		return parseAccountInput(body, current);
	} catch (error) {
		if (error instanceof AccountInputError) throw new ExternalAccountRefusal(400, error.message);
		throw error;
	}
}

/** The account's mail goes to a mailbox the user has full access to (spec §12). */
async function assertMailbox(env: CloudflareEnv, actor: AccountActor, mailboxId: string): Promise<void> {
	const access = await getMailboxAccessLevel(getDb(env), actor, mailboxId);
	if (!access?.canManage) throw new ExternalAccountRefusal(404, "Mailbox not found");
}

/** An address on one of this install's own domains already arrives here and is never connected (spec §7.2). */
async function assertNotKiteDomain(env: CloudflareEnv, address: string): Promise<void> {
	const domain = addressDomain(address)!;
	const [kiteDomain] = await getDb(env)
		.select({ id: domains.id })
		.from(domains)
		.where(eq(domains.hostname, domain))
		.limit(1);
	if (kiteDomain)
		throw new ExternalAccountRefusal(
			409,
			`${domain} is a domain of this Kite. Its mail already arrives here, so it cannot be connected.`,
			"KITE_DOMAIN",
		);
}

/**
 * An address is connected once per install. Checked only after a successful sign-in, so nobody learns whether an
 * address is connected without proving its password, and the answer never says by whom.
 */
async function assertAddressFree(env: CloudflareEnv, actor: AccountActor, address: string, exceptId?: string) {
	const [taken] = await getDb(env)
		.select({ userId: externalAccounts.userId })
		.from(externalAccounts)
		.where(
			exceptId
				? and(eq(externalAccounts.address, address), ne(externalAccounts.id, exceptId))
				: eq(externalAccounts.address, address),
		)
		.limit(1);
	if (taken)
		throw new ExternalAccountRefusal(
			409,
			taken.userId === actor.id ? "You have already connected this account" : "This address is already connected",
			"ADDRESS_TAKEN",
		);
}

/** Refuses a server Kite must not connect to, with the reason shown to the user. */
async function assertServers(env: CloudflareEnv, input: ExternalAccountInput): Promise<void> {
	try {
		await assertMailServerHost(env, input.imap.host, input.imap.port);
		if (input.smtp) await assertMailServerHost(env, input.smtp.host, input.smtp.port);
	} catch (error) {
		if (error instanceof MailServerRefusedError) throw new ExternalAccountRefusal(400, error.message, "SERVER_REFUSED");
		throw error;
	}
}

function loginFor(input: Pick<ExternalAccountInput, "imap" | "username">, password: string): ImapLogin {
	return { ...input.imap, username: input.username, password };
}

/** Counts one attempt against the user's limit (429 past it); runs before any other check of the attempt. */
function countAttempt(
	env: CloudflareEnv,
	userId: string,
	input: Pick<ExternalAccountInput, "imap" | "preset">,
	accountId?: string,
) {
	return recordConnectionTest(env, userId, {
		host: input.imap.host,
		port: input.imap.port,
		preset: input.preset,
		...(accountId ? { accountId } : {}),
	});
}

function failedTest(problem: ConnectionProblem): ExternalAccountRefusal {
	return new ExternalAccountRefusal(400, problem.message, `CONNECTION_${problem.kind.toUpperCase()}`);
}

function presetFields(input: ExternalAccountInput) {
	const preset = findPreset(input.preset)!;
	if (!preset.passwordSignIn) throw new ExternalAccountRefusal(400, preset.passwordHelp, "OAUTH_REQUIRED");
	return {
		appendSent: preset.appendSent,
		trustAuthResults: presetTrustsAuthResults(preset),
	};
}

function accountColumns(input: ExternalAccountInput) {
	return {
		label: input.label,
		address: input.address,
		displayName: input.displayName,
		preset: input.preset,
		mailboxId: input.mailboxId,
		imapHost: input.imap.host,
		imapPort: input.imap.port,
		imapSecurity: input.imap.security,
		smtpHost: input.smtp?.host ?? null,
		smtpPort: input.smtp?.port ?? null,
		smtpSecurity: input.smtp?.security ?? null,
		username: input.username,
	};
}

/** Stores where INBOX stood at the test, unless the account already has a cursor there (a reconnect). */
async function saveBaseline(env: CloudflareEnv, accountId: string, baseline: ImapBaseline): Promise<void> {
	await getDb(env)
		.insert(externalAccountFolders)
		.values({
			accountId,
			name: "INBOX",
			role: "inbox",
			uidvalidity: baseline.uidValidity,
			uidnext: baseline.uidNext,
			lastUid: baseline.uidNext !== null ? Math.max(baseline.uidNext - 1, 0) : null,
			lastCheckedAt: new Date(),
		})
		.onConflictDoNothing();
}

const isUniqueViolation = (error: unknown) =>
	/UNIQUE constraint failed/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "");

/**
 * Connects an account (spec §6.3, §11): the Kite password again, the checks on the mailbox, the address and the
 * servers, a successful IMAP sign-in, then the row with the password sealed and the INBOX baseline.
 */
export async function connectExternalAccount(
	env: CloudflareEnv,
	actor: AccountActor,
	body: Record<string, unknown>,
): Promise<ExternalAccountView> {
	await assertAllowed(env, actor.id);
	const input = parse(body);
	const fromPreset = presetFields(input);
	const password = passwordFrom(body.password);
	if (!password) throw new ExternalAccountRefusal(400, "Enter the account's password or app password");
	// The limit comes first, so the Kite password and the other checks cannot be tried more often than it allows.
	await countAttempt(env, actor.id, input);
	assertKitePassword(actor, body.kitePassword);
	await assertMailbox(env, actor, input.mailboxId);
	await assertNotKiteDomain(env, input.address);
	await assertServers(env, input);
	const test = await testImapConnection(env, loginFor(input, password));
	if (!test.ok) throw failedTest(test.problem);
	await assertAddressFree(env, actor, input.address);
	const now = new Date();
	const id = newId("xacct");
	try {
		await getDb(env)
			.insert(externalAccounts)
			.values({
				id,
				userId: actor.id,
				...accountColumns(input),
				...fromPreset,
				secret: await sealSetting(env, password),
				status: "active",
				createdAt: now,
				updatedAt: now,
			});
	} catch (error) {
		if (isUniqueViolation(error))
			throw new ExternalAccountRefusal(409, "This address is already connected", "ADDRESS_TAKEN");
		throw error;
	}
	await saveBaseline(env, id, test.baseline);
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_account.connected",
		mailboxId: input.mailboxId,
		metadata: { accountId: id, address: input.address, preset: input.preset, host: input.imap.host },
	});
	return serializeExternalAccount(await ownAccount(env, actor.id, id));
}

/**
 * Edits an account, only while the user may use connected accounts. The label, display name and mailbox change at
 * once. Changing what Kite signs in with or where the password goes (address, user name, provider, IMAP or SMTP
 * server) needs the account's password again, the Kite password and a passing test with that new password: a saved
 * password is never sent to a server other than the one it was saved for.
 */
export async function updateExternalAccount(
	env: CloudflareEnv,
	actor: AccountActor,
	id: string,
	body: Record<string, unknown>,
): Promise<ExternalAccountView> {
	const row = await ownAccount(env, actor.id, id);
	await assertAllowed(env, actor.id);
	const current = serializeExternalAccount(row);
	const input = parse(body, current);
	const password = passwordFrom(body.password);
	const signIn = password !== null || changesSignIn(current, input);
	if (input.mailboxId !== current.mailboxId) await assertMailbox(env, actor, input.mailboxId);
	const changes: Partial<typeof externalAccounts.$inferInsert> = { ...accountColumns(input), updatedAt: new Date() };
	if (signIn) Object.assign(changes, await reconnect(env, actor, { id, current, input, password, body }));
	await getDb(env)
		.update(externalAccounts)
		.set(changes)
		.where(and(eq(externalAccounts.id, id), eq(externalAccounts.userId, actor.id)));
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_account.updated",
		mailboxId: input.mailboxId,
		metadata: { accountId: id, address: input.address, signInChanged: signIn, passwordChanged: !!password },
	});
	return serializeExternalAccount(await ownAccount(env, actor.id, id));
}

/** The sign-in part of an edit: the checks of a connect, with the new password; returns the columns to write. */
async function reconnect(
	env: CloudflareEnv,
	actor: AccountActor,
	edit: {
		id: string;
		current: ExternalAccountView;
		input: ExternalAccountInput;
		password: string | null;
		body: Record<string, unknown>;
	},
): Promise<Partial<typeof externalAccounts.$inferInsert>> {
	const { id, current, input, password } = edit;
	const fromPreset = presetFields(input);
	if (!password)
		throw new ExternalAccountRefusal(
			400,
			"Enter the account's password again to change its address, user name or servers",
			"PASSWORD_REQUIRED",
		);
	await countAttempt(env, actor.id, input, id);
	assertKitePassword(actor, edit.body.kitePassword);
	if (input.address !== current.address) await assertNotKiteDomain(env, input.address);
	await assertServers(env, input);
	const test = await testImapConnection(env, loginFor(input, password));
	if (!test.ok) throw failedTest(test.problem);
	if (input.address !== current.address) await assertAddressFree(env, actor, input.address, id);
	// Another server or login is another mailbox: its INBOX position starts again from this test.
	const sameInbox =
		current.imap.host === input.imap.host &&
		current.imap.port === input.imap.port &&
		current.username === input.username;
	if (!sameInbox) await getDb(env).delete(externalAccountFolders).where(eq(externalAccountFolders.accountId, id));
	await saveBaseline(env, id, test.baseline);
	return {
		...fromPreset,
		secret: await sealSetting(env, password),
		status: "active",
		statusReason: null,
		lastError: null,
		consecutiveFailures: 0,
	};
}

/** The saved password, or null when it was erased or can no longer be opened (APP_ENCRYPTION_KEY changed). */
async function openStoredSecret(env: CloudflareEnv, row: ExternalAccountRow): Promise<string | null> {
	if (!row.secret) return null;
	try {
		return await openSetting(env, row.secret);
	} catch (error) {
		if (error instanceof SecretBoxError) return null;
		throw error;
	}
}

/** **Test connection** for a saved account: signs in with the saved password and records the outcome as its state. */
export async function retestExternalAccount(
	env: CloudflareEnv,
	actor: AccountActor,
	id: string,
): Promise<AccountTestOutcome> {
	const row = await ownAccount(env, actor.id, id);
	await assertAllowed(env, actor.id);
	const view = serializeExternalAccount(row);
	const now = new Date();
	const db = getDb(env);
	const secret = await openStoredSecret(env, row);
	if (!secret) {
		const problem: ConnectionProblem = {
			kind: "auth",
			message: "The saved password is no longer available. Reconnect the account.",
		};
		await db
			.update(externalAccounts)
			.set({ status: "auth_failed", lastError: problem.message, updatedAt: now })
			.where(eq(externalAccounts.id, id));
		return { account: serializeExternalAccount(await ownAccount(env, actor.id, id)), problem };
	}
	await countAttempt(env, actor.id, view, id);
	const test = await testImapConnection(env, loginFor(view, secret));
	if (test.ok) {
		// A paused account stays paused: a test proves the sign-in, not that the owner wants it running.
		await db
			.update(externalAccounts)
			.set({
				...(row.status === "paused" || row.status === "disabled"
					? {}
					: { status: "active" as const, statusReason: null }),
				lastError: null,
				consecutiveFailures: 0,
				updatedAt: now,
			})
			.where(eq(externalAccounts.id, id));
	} else {
		const status = problemStatus[test.problem.kind];
		await db
			.update(externalAccounts)
			.set({
				...(status ? { status } : {}),
				lastError: test.problem.message,
				recentErrors: appendRecentError(row.recentErrors, test.problem.message, now),
				updatedAt: now,
			})
			.where(eq(externalAccounts.id, id));
	}
	return {
		account: serializeExternalAccount(await ownAccount(env, actor.id, id)),
		problem: test.ok ? null : test.problem,
	};
}

/**
 * Removes an account: its password, cursors and settings go; its mail stays (spec §6.7). Imports from it stop at
 * their next run, because the job's `external_account_id` is set to null with it.
 */
export async function removeExternalAccount(env: CloudflareEnv, actor: AccountActor, id: string): Promise<void> {
	const row = await ownAccount(env, actor.id, id);
	await getDb(env)
		.delete(externalAccounts)
		.where(and(eq(externalAccounts.id, id), eq(externalAccounts.userId, actor.id)));
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_account.removed",
		mailboxId: row.mailboxId,
		metadata: { accountId: id, address: row.address, preset: row.preset },
	});
}
