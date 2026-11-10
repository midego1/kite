import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { isLoopbackHost } from "@/lib/net/host-guard-utils";
import { openSetting, SecretBoxError, sealSetting } from "@/lib/security/secret-box";
import { auditExternalAccount } from "./audit";
import { testImapConnection } from "./connection-test";
import { ExternalAccountRefusal, migrationPending } from "./errors";
import { oauthTestOriginFor, resolveMicrosoftClient } from "./oauth-client";
import {
	capOAuthStates,
	insertOAuthState,
	oauthTablesReady,
	type OAuthStatePayload,
	pruneOAuthStates,
	takeOAuthState,
	writeAccountOAuth,
} from "./oauth-store";
import { exchangeAuthorizationCode } from "./oauth-tokens";
import {
	aadstsCode,
	grantsImap,
	hashOAuthState,
	idTokenClaims,
	MICROSOFT_IMAP,
	MICROSOFT_SMTP,
	microsoftAuthorizeUrl,
	microsoftEndpoints,
	OAUTH_STATE_TTL_MS,
	OAuthTokenError,
	oauthRedirectUri,
	parseCallbackState,
	pkceChallenge,
	randomUrlToken,
	sameMailAddress,
} from "./oauth-utils";
import { addressDomain, findPreset } from "./presets-utils";
import {
	type AccountActor,
	addressConflict,
	assertAddressFree,
	assertAllowed,
	assertKitePassword,
	assertMailbox,
	assertNotKiteDomain,
	countAttempt,
	isUniqueViolation,
	ownAccount,
	saveBaseline,
	verifySending,
} from "./service";
import { accountSwitches } from "./switches";
import { DEFAULT_SYNC_INTERVAL_MINUTES, parseSyncInterval } from "./sync-utils";
import type { ExternalAccountRow } from "./serialize-utils";
import type { MailServerSettings } from "./types";

const logger = createLogger("external");

/** Sign-ins one user may have open at once (several tabs); older ones are dropped. */
const OPEN_SIGN_INS_PER_USER = 5;

const text = (value: unknown, max: number) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The e2e fakes' IMAP and SMTP servers, accepted only while `EXTERNAL_OAUTH_TEST_ORIGIN` is in effect (never in
 * production) and only on loopback; everywhere else a Microsoft account uses Microsoft's own servers.
 */
function testServers(env: CloudflareEnv, value: unknown): OAuthStatePayload["testServers"] {
	if (!oauthTestOriginFor(env) || !value || typeof value !== "object") return null;
	const server = (entry: unknown): MailServerSettings | null => {
		const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		const host = typeof item.host === "string" ? item.host : "";
		const port = Number(item.port);
		const security = item.security === "starttls" ? "starttls" : item.security === "tls" ? "tls" : null;
		return isLoopbackHost(host) && Number.isInteger(port) && port > 0 && port < 65536 && security
			? { host, port, security }
			: null;
	};
	const servers = value as { imap?: unknown; smtp?: unknown };
	const imap = server(servers.imap);
	const smtp = server(servers.smtp);
	return imap && smtp ? { imap, smtp } : null;
}

/**
 * **Sign in with Microsoft** (spec §15.2): the same checks as connecting with a password (the limit first, then the
 * Kite password and the mailbox), then a single-use state with a sealed PKCE verifier, and the URL of Microsoft's
 * sign-in page. With `accountId` it reconnects that account of the user's. Nothing is connected until the callback.
 */
export async function startMicrosoftSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	body: Record<string, unknown>,
	requestOrigin: string,
): Promise<{ url: string }> {
	await assertAllowed(env, actor.id);
	if (!(await oauthTablesReady(env))) throw migrationPending();
	const client = await resolveMicrosoftClient(env);
	if (!client)
		throw new ExternalAccountRefusal(
			409,
			"Microsoft sign-in is not set up on this Kite. Ask your admin to set it up in Admin → General.",
			"OAUTH_NOT_CONFIGURED",
		);
	const accountId = text(body.accountId, 64);
	const reconnecting = accountId ? await ownAccount(env, actor.id, accountId) : null;
	if (reconnecting && reconnecting.preset !== "microsoft")
		throw new ExternalAccountRefusal(400, "This account does not sign in with Microsoft", "NOT_MICROSOFT");
	await countAttempt(env, actor.id, { imap: MICROSOFT_IMAP, preset: "microsoft" }, accountId ?? undefined);
	assertKitePassword(actor, body.kitePassword);
	const mailboxId = reconnecting?.mailboxId ?? text(body.mailboxId, 64);
	if (!mailboxId) throw new ExternalAccountRefusal(400, "Choose the mailbox the account's mail goes to");
	if (!reconnecting) await assertMailbox(env, actor, mailboxId);
	const typed = text(body.address, 320)?.toLowerCase() ?? null;
	const now = new Date();
	const state = randomUrlToken();
	const verifier = randomUrlToken();
	const redirectUri = oauthRedirectUri(env.APP_URL, requestOrigin);
	const payload: OAuthStatePayload = {
		mailboxId,
		label: text(body.label, 200),
		displayName: text(body.displayName, 200),
		loginHint: reconnecting?.address ?? (typed && addressDomain(typed) ? typed : null),
		syncIntervalMinutes: parseSyncInterval(body.syncIntervalMinutes),
		switches: accountSwitches(body) as Record<string, boolean>,
		testServers: testServers(env, body.testServers),
		redirectUri,
	};
	await pruneOAuthStates(env, now);
	await insertOAuthState(
		env,
		await hashOAuthState(state),
		{
			userId: actor.id,
			provider: "microsoft",
			sealedVerifier: await sealSetting(env, verifier),
			accountId: reconnecting?.id ?? null,
			payload,
			expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
		},
		now,
	);
	await capOAuthStates(env, actor.id, OPEN_SIGN_INS_PER_USER);
	return {
		url: microsoftAuthorizeUrl({
			endpoints: microsoftEndpoints(client.tenant, oauthTestOriginFor(env)),
			clientId: client.clientId,
			redirectUri,
			state,
			challenge: await pkceChallenge(verifier),
			loginHint: payload.loginHint,
		}),
	};
}

/** Why a sign-in did not connect an account: a code the Connected accounts page turns into words. */
export type OAuthCallbackFailure =
	| "expired"
	| "cancelled"
	| "admin_consent"
	| "denied"
	| "not_configured"
	| "token"
	| "no_address"
	| "no_refresh_token"
	| "scopes"
	| "different_account"
	| "imap_refused"
	| "not_allowed"
	| "kite_domain"
	| "address_taken"
	| "migration_pending"
	| "failed";

export type OAuthCallbackOutcome =
	{ ok: true; accountId: string; reconnected: boolean } | { ok: false; reason: OAuthCallbackFailure };

class CallbackFailure extends Error {
	constructor(readonly reason: OAuthCallbackFailure) {
		super(reason);
		this.name = "CallbackFailure";
	}
}

/** Microsoft's own error on the redirect (`error`, `error_description`): only the code is read. */
function authorizeFailure(error: string, description: string | null): OAuthCallbackFailure {
	const code = aadstsCode(description);
	if (code === "AADSTS65001" || code === "AADSTS90094" || code === "AADSTS90099") return "admin_consent";
	if (error === "access_denied") return code === "AADSTS65004" || !code ? "cancelled" : "denied";
	if (error === "consent_required") return "admin_consent";
	return "denied";
}

const REFUSAL_REASONS: Record<string, OAuthCallbackFailure> = {
	KITE_DOMAIN: "kite_domain",
	ADDRESS_TAKEN: "address_taken",
	MIGRATION_PENDING: "migration_pending",
	NO_KEY: "not_allowed",
	INSTALL_OFF: "not_allowed",
	NOT_PERMITTED: "not_allowed",
};

/**
 * The callback (spec §15.2): takes the state (once, for this user, within 10 minutes), redeems the code with its PKCE
 * verifier, reads the address from the ID token, signs in to IMAP with XOAUTH2, and then connects the account with
 * the refresh token sealed, or, for a reconnect, replaces the tokens of the same address.
 */
export async function completeMicrosoftSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
): Promise<OAuthCallbackOutcome> {
	try {
		return await complete(env, actor, params);
	} catch (error) {
		if (error instanceof CallbackFailure) return { ok: false, reason: error.reason };
		if (error instanceof ExternalAccountRefusal)
			return { ok: false, reason: REFUSAL_REASONS[error.code ?? ""] ?? "failed" };
		logger.error("external.oauth.callback_failed", { error: error instanceof Error ? error.name : "unknown" });
		return { ok: false, reason: "failed" };
	}
}

type PendingSignIn = NonNullable<Awaited<ReturnType<typeof takeOAuthState>>>;
type ServerPair = { imap: MailServerSettings; smtp: MailServerSettings };

/** The state of this callback, taken (once) for this user within its 10 minutes, and the code Microsoft sent. */
async function takePendingSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
): Promise<{ pending: PendingSignIn; code: string }> {
	if (!(await oauthTablesReady(env))) throw new CallbackFailure("migration_pending");
	const state = parseCallbackState(params.get("state"));
	const pending = state ? await takeOAuthState(env, await hashOAuthState(state)) : null;
	// Another user's state answers like a missing one, and is gone either way.
	if (!pending || pending.userId !== actor.id || pending.provider !== "microsoft") throw new CallbackFailure("expired");
	if (pending.expiresAt.getTime() < Date.now()) throw new CallbackFailure("expired");
	const error = params.get("error");
	if (error) throw new CallbackFailure(authorizeFailure(error, params.get("error_description")));
	const code = params.get("code");
	if (!code) throw new CallbackFailure("denied");
	return { pending, code };
}

/** Redeems the code with the state's PKCE verifier and checks what came back: an address, a refresh token, IMAP. */
async function redeemCode(env: CloudflareEnv, pending: PendingSignIn, code: string) {
	const client = await resolveMicrosoftClient(env);
	if (!client) throw new CallbackFailure("not_configured");
	const verifier = await openSetting(env, pending.sealedVerifier).catch((openError: unknown) => {
		if (openError instanceof SecretBoxError) return null;
		throw openError;
	});
	if (!verifier) throw new CallbackFailure("expired");
	const tokens = await exchangeAuthorizationCode(env, client, {
		code,
		verifier,
		redirectUri: pending.payload.redirectUri,
	}).catch((tokenError: unknown) => {
		if (!(tokenError instanceof OAuthTokenError)) throw tokenError;
		logger.warn("external.oauth.code_refused", { kind: tokenError.kind, code: tokenError.code });
		throw new CallbackFailure("token");
	});
	const claims = idTokenClaims(tokens.idToken, client.clientId);
	if (!claims) throw new CallbackFailure("no_address");
	if (!tokens.refreshToken) throw new CallbackFailure("no_refresh_token");
	if (!grantsImap(tokens.scopes)) throw new CallbackFailure("scopes");
	return { tokens: { ...tokens, refreshToken: tokens.refreshToken }, claims };
}

/** A new Microsoft account row, with the refresh token sealed in `secret`; its address must still be free. */
async function insertMicrosoftAccount(
	env: CloudflareEnv,
	actor: AccountActor,
	input: { payload: OAuthStatePayload; address: string; servers: ServerPair; sealedRefreshToken: string; now: Date },
): Promise<string> {
	const { payload, address, servers, now } = input;
	await assertAddressFree(env, actor, { address, preset: "microsoft" });
	const id = newId("xacct");
	try {
		await getDb(env)
			.insert(externalAccounts)
			.values({
				id,
				userId: actor.id,
				mailboxId: payload.mailboxId,
				label: payload.label ?? address,
				address,
				displayName: payload.displayName,
				preset: "microsoft",
				authKind: "oauth_microsoft",
				imapHost: servers.imap.host,
				imapPort: servers.imap.port,
				imapSecurity: servers.imap.security,
				smtpHost: servers.smtp.host,
				smtpPort: servers.smtp.port,
				smtpSecurity: servers.smtp.security,
				username: address,
				appendSent: findPreset("microsoft")!.appendSent,
				trustAuthResults: false,
				syncIntervalMinutes: payload.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
				...accountSwitches(payload.switches),
				secret: input.sealedRefreshToken,
				status: "active",
				createdAt: now,
				updatedAt: now,
			});
	} catch (insertError) {
		if (isUniqueViolation(insertError)) throw addressConflict("microsoft");
		throw insertError;
	}
	return id;
}

/** A reconnect: the new refresh token replaces the old one, and checking starts again at the next tick. */
async function renewAccount(env: CloudflareEnv, actor: AccountActor, accountId: string, sealedRefreshToken: string) {
	await getDb(env)
		.update(externalAccounts)
		.set({
			secret: sealedRefreshToken,
			status: "active",
			statusReason: null,
			lastError: null,
			consecutiveFailures: 0,
			nextSyncAt: null,
			lastSyncAt: null,
			updatedAt: new Date(),
		})
		.where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.userId, actor.id)));
}

const rowServers = (row: ExternalAccountRow): ServerPair => ({
	imap: { host: row.imapHost, port: row.imapPort, security: row.imapSecurity },
	smtp: {
		host: row.smtpHost ?? MICROSOFT_SMTP.host,
		port: row.smtpPort ?? MICROSOFT_SMTP.port,
		security: row.smtpSecurity ?? MICROSOFT_SMTP.security,
	},
});

async function complete(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
): Promise<OAuthCallbackOutcome> {
	const { pending, code } = await takePendingSignIn(env, actor, params);
	await assertAllowed(env, actor.id);
	const { tokens, claims } = await redeemCode(env, pending, code);
	const reconnecting = pending.accountId ? await ownAccount(env, actor.id, pending.accountId) : null;
	if (reconnecting && !sameMailAddress(reconnecting.address, claims.address))
		throw new CallbackFailure("different_account");
	if (!reconnecting) {
		await assertNotKiteDomain(env, claims.address);
		await assertMailbox(env, actor, pending.payload.mailboxId);
	}
	const servers = reconnecting
		? rowServers(reconnecting)
		: (pending.payload.testServers ?? { imap: { ...MICROSOFT_IMAP }, smtp: { ...MICROSOFT_SMTP } });
	const login = { username: claims.address, password: "", accessToken: tokens.accessToken };
	const test = await testImapConnection(env, { ...servers.imap, ...login });
	if (!test.ok) {
		logger.warn("external.oauth.imap_refused", { kind: test.problem.kind });
		throw new CallbackFailure("imap_refused");
	}
	const sealedRefreshToken = await sealSetting(env, tokens.refreshToken);
	const accountId =
		reconnecting?.id ??
		(await insertMicrosoftAccount(env, actor, {
			payload: pending.payload,
			address: claims.address,
			servers,
			sealedRefreshToken,
			now: new Date(),
		}));
	if (reconnecting) await renewAccount(env, actor, accountId, sealedRefreshToken);
	await writeAccountOAuth(env, accountId, {
		sealedAccessToken: await sealSetting(env, tokens.accessToken),
		expiresAt: tokens.expiresAt,
		scopes: tokens.scopes,
		subject: claims.subject,
	});
	await saveBaseline(env, accountId, test.baseline);
	const sendProblem = await verifySending(env, accountId, { smtp: servers.smtp, username: claims.address }, login);
	if (sendProblem)
		await getDb(env)
			.update(externalAccounts)
			.set({ lastError: sendProblem.message })
			.where(eq(externalAccounts.id, accountId));
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: reconnecting ? "external_account.updated" : "external_account.connected",
		mailboxId: reconnecting?.mailboxId ?? pending.payload.mailboxId,
		metadata: {
			accountId,
			address: claims.address,
			preset: "microsoft",
			signIn: "microsoft",
			...(reconnecting
				? { signInChanged: true, passwordChanged: false }
				: { host: servers.imap.host, sendingVerified: !sendProblem }),
		},
	});
	return { ok: true, accountId, reconnected: !!reconnecting };
}
