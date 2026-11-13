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
import { type OAuthApp, resolveOAuthApp } from "./oauth-app";
import { oauthTestOriginFor } from "./oauth-client";
import { googleAuthorizeFailure } from "./oauth-google-utils";
import {
	isOAuthProvider,
	OAUTH_PROVIDERS,
	oauthAccountPreset,
	type OAuthProviderId,
	type OAuthProviderInfo,
} from "./oauth-provider-utils";
import {
	capOAuthStates,
	insertOAuthState,
	oauthTablesReady,
	type OAuthStatePayload,
	pruneOAuthStates,
	readOAuthSubject,
	takeOAuthState,
	writeAccountOAuth,
} from "./oauth-store";
import { exchangeAuthorizationCode } from "./oauth-tokens";
import {
	aadstsCode,
	hashOAuthState,
	OAUTH_STATE_TTL_MS,
	OAuthTokenError,
	type OAuthIdentity,
	oauthRedirectUri,
	parseCallbackState,
	pkceChallenge,
	randomUrlToken,
	sameMailAddress,
} from "./oauth-utils";
import { addressDomain, findPreset, presetTrustsAuthResults } from "./presets-utils";
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
import type { ExternalAccountPresetId, MailServerSettings } from "./types";

const logger = createLogger("external");

/** Sign-ins one user may have open at once (several tabs); older ones are dropped. */
const OPEN_SIGN_INS_PER_USER = 5;

const text = (value: unknown, max: number) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The e2e fakes' IMAP and SMTP servers, accepted only while `EXTERNAL_OAUTH_TEST_ORIGIN` is in effect (never in
 * production) and only on loopback; everywhere else an account uses its provider's own servers.
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

/** The preset a sign-in starts for: the account's own on a reconnect, else the one chosen, else the provider's first. */
function startPreset(info: OAuthProviderInfo, chosen: unknown): ExternalAccountPresetId {
	return info.presets.find((preset) => preset === chosen) ?? info.presets[0];
}

/** What the state carries to the callback: the connect form's choices, never a secret. */
function statePayload(
	env: CloudflareEnv,
	body: Record<string, unknown>,
	fixed: { mailboxId: string; redirectUri: string; reconnectAddress: string | null },
): OAuthStatePayload {
	const typed = text(body.address, 320)?.toLowerCase() ?? null;
	return {
		mailboxId: fixed.mailboxId,
		label: text(body.label, 200),
		displayName: text(body.displayName, 200),
		loginHint: fixed.reconnectAddress ?? (typed && addressDomain(typed) ? typed : null),
		syncIntervalMinutes: parseSyncInterval(body.syncIntervalMinutes),
		switches: accountSwitches(body) as Record<string, boolean>,
		testServers: testServers(env, body.testServers),
		redirectUri: fixed.redirectUri,
	};
}

/**
 * **Sign in with Microsoft** or **Sign in with Google** (spec §15.2, §15.7): the same checks as connecting with a
 * password (the limit first, then the Kite password and the mailbox), then a single-use state with a sealed PKCE
 * verifier, and the URL of the provider's sign-in page. With `accountId` it reconnects that account of the user's (for
 * Google also a Gmail account that used an app password until now). Nothing is connected until the callback.
 */
export async function startOAuthSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	provider: OAuthProviderId,
	body: Record<string, unknown>,
	requestOrigin: string,
): Promise<{ url: string }> {
	const info = OAUTH_PROVIDERS[provider];
	await assertAllowed(env, actor.id);
	if (!(await oauthTablesReady(env))) throw migrationPending();
	const app = await resolveOAuthApp(env, provider);
	if (!app)
		throw new ExternalAccountRefusal(
			409,
			`${info.label} sign-in is not set up on this Kite. Ask your admin to set it up in Admin → General.`,
			"OAUTH_NOT_CONFIGURED",
		);
	const accountId = text(body.accountId, 64);
	const reconnecting = accountId ? await ownAccount(env, actor.id, accountId) : null;
	if (reconnecting && !info.presets.includes(reconnecting.preset))
		throw new ExternalAccountRefusal(
			400,
			`This account does not sign in with ${info.label}`,
			`NOT_${provider.toUpperCase()}`,
		);
	const preset = reconnecting?.preset ?? startPreset(info, body.preset);
	await countAttempt(env, actor.id, { imap: info.imap, preset }, accountId ?? undefined);
	assertKitePassword(actor, body.kitePassword);
	const mailboxId = reconnecting?.mailboxId ?? text(body.mailboxId, 64);
	if (!mailboxId) throw new ExternalAccountRefusal(400, "Choose the mailbox the account's mail goes to");
	if (!reconnecting) await assertMailbox(env, actor, mailboxId);
	const now = new Date();
	const state = randomUrlToken();
	const verifier = randomUrlToken();
	const redirectUri = oauthRedirectUri(env.APP_URL, requestOrigin);
	const payload = statePayload(env, body, { mailboxId, redirectUri, reconnectAddress: reconnecting?.address ?? null });
	await pruneOAuthStates(env, now);
	await insertOAuthState(
		env,
		await hashOAuthState(state),
		{
			userId: actor.id,
			provider,
			sealedVerifier: await sealSetting(env, verifier),
			accountId: reconnecting?.id ?? null,
			payload,
			expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
		},
		now,
	);
	await capOAuthStates(env, actor.id, OPEN_SIGN_INS_PER_USER);
	return {
		url: app.authorizeUrl({
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
	| "wrong_domain"
	| "no_refresh_token"
	| "scopes"
	| "different_account"
	| "account_changed"
	| "imap_refused"
	| "not_allowed"
	| "kite_domain"
	| "address_taken"
	| "migration_pending"
	| "failed";

/** How a callback went, with the provider once its state was found (a missing or foreign state names none). */
export type OAuthCallbackOutcome =
	| { ok: true; provider: OAuthProviderId; accountId: string; reconnected: boolean }
	| { ok: false; reason: OAuthCallbackFailure; provider: OAuthProviderId | null };

class CallbackFailure extends Error {
	constructor(readonly reason: OAuthCallbackFailure) {
		super(reason);
		this.name = "CallbackFailure";
	}
}

/** Microsoft's own error on the redirect (`error`, `error_description`): only the code is read. */
function microsoftAuthorizeFailure(error: string, description: string | null): OAuthCallbackFailure {
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
 * The callback (spec §15.2), one for both providers: takes the state (once, for this user, within 10 minutes), which
 * names the provider, redeems the code with its PKCE verifier, reads the address from the ID token, signs in to IMAP
 * with XOAUTH2, and then connects the account with the refresh token sealed, or, for a reconnect, replaces the tokens
 * of the same account.
 */
export async function completeOAuthSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
): Promise<OAuthCallbackOutcome> {
	const seen: { provider: OAuthProviderId | null } = { provider: null };
	try {
		return await complete(env, actor, params, seen);
	} catch (error) {
		if (error instanceof CallbackFailure) return { ok: false, reason: error.reason, provider: seen.provider };
		if (error instanceof ExternalAccountRefusal)
			return { ok: false, reason: REFUSAL_REASONS[error.code ?? ""] ?? "failed", provider: seen.provider };
		logger.error("external.oauth.callback_failed", {
			provider: seen.provider,
			error: error instanceof Error ? error.name : "unknown",
		});
		return { ok: false, reason: "failed", provider: seen.provider };
	}
}

type PendingSignIn = NonNullable<Awaited<ReturnType<typeof takeOAuthState>>>;
type ServerPair = { imap: MailServerSettings; smtp: MailServerSettings };

/** The state of this callback, taken (once) for this user, and the provider it was started for. */
async function takePendingSignIn(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
): Promise<{ pending: PendingSignIn; provider: OAuthProviderId }> {
	if (!(await oauthTablesReady(env))) throw new CallbackFailure("migration_pending");
	const state = parseCallbackState(params.get("state"));
	const pending = state ? await takeOAuthState(env, await hashOAuthState(state)) : null;
	// Another user's state answers like a missing one, and is gone either way.
	if (!pending || pending.userId !== actor.id || !isOAuthProvider(pending.provider))
		throw new CallbackFailure("expired");
	return { pending, provider: pending.provider };
}

/** The provider's answer on the redirect: its error, or the code to redeem. */
function callbackCode(provider: OAuthProviderId, params: URLSearchParams): string {
	const error = params.get("error");
	if (error)
		throw new CallbackFailure(
			provider === "google"
				? googleAuthorizeFailure(error)
				: microsoftAuthorizeFailure(error, params.get("error_description")),
		);
	const code = params.get("code");
	if (!code) throw new CallbackFailure("denied");
	return code;
}

/** Redeems the code with the state's PKCE verifier and checks what came back: an identity, a refresh token, IMAP. */
async function redeemCode(env: CloudflareEnv, app: OAuthApp, pending: PendingSignIn, code: string) {
	const verifier = await openSetting(env, pending.sealedVerifier).catch((openError: unknown) => {
		if (openError instanceof SecretBoxError) return null;
		throw openError;
	});
	if (!verifier) throw new CallbackFailure("expired");
	const tokens = await exchangeAuthorizationCode(app, {
		code,
		verifier,
		redirectUri: pending.payload.redirectUri,
	}).catch((tokenError: unknown) => {
		if (!(tokenError instanceof OAuthTokenError)) throw tokenError;
		logger.warn("external.oauth.code_refused", {
			provider: app.provider.id,
			kind: tokenError.kind,
			code: tokenError.code,
		});
		throw new CallbackFailure("token");
	});
	const identity = await app.identity(tokens.idToken);
	if (typeof identity === "string") throw new CallbackFailure(identity);
	if (!tokens.refreshToken) throw new CallbackFailure("no_refresh_token");
	if (!app.grantsMail(tokens.scopes)) throw new CallbackFailure("scopes");
	return { tokens: { ...tokens, refreshToken: tokens.refreshToken }, identity };
}

/** A new account row, with the refresh token sealed in `secret`; its address must still be free. */
async function insertOAuthAccount(
	env: CloudflareEnv,
	actor: AccountActor,
	input: {
		info: OAuthProviderInfo;
		payload: OAuthStatePayload;
		address: string;
		servers: ServerPair;
		sealedRefreshToken: string;
		now: Date;
	},
): Promise<string> {
	const { info, payload, address, servers, now } = input;
	const preset = findPreset(oauthAccountPreset(info.id, address))!;
	await assertAddressFree(env, actor, { address, preset: preset.id });
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
				preset: preset.id,
				authKind: info.authKind,
				imapHost: servers.imap.host,
				imapPort: servers.imap.port,
				imapSecurity: servers.imap.security,
				smtpHost: servers.smtp.host,
				smtpPort: servers.smtp.port,
				smtpSecurity: servers.smtp.security,
				username: address,
				appendSent: preset.appendSent,
				trustAuthResults: presetTrustsAuthResults(preset),
				syncIntervalMinutes: payload.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
				...accountSwitches(payload.switches),
				secret: input.sealedRefreshToken,
				status: "active",
				createdAt: now,
				updatedAt: now,
			});
	} catch (insertError) {
		if (isUniqueViolation(insertError)) throw addressConflict(preset.id);
		throw insertError;
	}
	return id;
}

/**
 * A reconnect: the account is active again and checking starts at the next tick. The new refresh token (and, for a
 * Gmail account that used an app password, the new sign-in kind) is written by `writeAccountOAuth`, with the version
 * bump, so an older refresh still in flight cannot overwrite it.
 */
async function renewAccount(env: CloudflareEnv, actor: AccountActor, accountId: string) {
	await getDb(env)
		.update(externalAccounts)
		.set({
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

/**
 * A reconnect must sign in as the account it renews: the same address, and the same user id once one was recorded
 * (`<tid>:<oid>` at Microsoft, `sub` at Google: an address can be reassigned to another user, or exist in another
 * tenant).
 */
async function sameOAuthAccount(
	env: CloudflareEnv,
	row: ExternalAccountRow,
	identity: OAuthIdentity,
): Promise<boolean> {
	if (!sameMailAddress(row.address, identity.address)) return false;
	const recorded = await readOAuthSubject(env, row.id);
	return recorded === null || recorded === identity.subject;
}

const rowServers = (row: ExternalAccountRow, info: OAuthProviderInfo): ServerPair => ({
	imap: { host: row.imapHost, port: row.imapPort, security: row.imapSecurity },
	smtp: {
		host: row.smtpHost ?? info.smtp.host,
		port: row.smtpPort ?? info.smtp.port,
		security: row.smtpSecurity ?? info.smtp.security,
	},
});

/**
 * The account a reconnect renews, or null for a new one. Its preset is checked again here, as at the start and before
 * the code is redeemed: an account edited meanwhile to another provider (say "Other", with its own servers) must
 * never get this provider's access token sent to those servers.
 */
async function reconnectTarget(
	env: CloudflareEnv,
	actor: AccountActor,
	pending: PendingSignIn,
	info: OAuthProviderInfo,
): Promise<ExternalAccountRow | null> {
	if (!pending.accountId) return null;
	const row = await ownAccount(env, actor.id, pending.accountId);
	if (!info.presets.includes(row.preset)) throw new CallbackFailure("account_changed");
	return row;
}

async function complete(
	env: CloudflareEnv,
	actor: AccountActor,
	params: URLSearchParams,
	seen: { provider: OAuthProviderId | null },
): Promise<OAuthCallbackOutcome> {
	const { pending, provider } = await takePendingSignIn(env, actor, params);
	seen.provider = provider;
	const info = OAUTH_PROVIDERS[provider];
	if (pending.expiresAt.getTime() < Date.now()) throw new CallbackFailure("expired");
	const code = callbackCode(provider, params);
	await assertAllowed(env, actor.id);
	const app = await resolveOAuthApp(env, provider);
	if (!app) throw new CallbackFailure("not_configured");
	const reconnecting = await reconnectTarget(env, actor, pending, info);
	const { tokens, identity } = await redeemCode(env, app, pending, code);
	if (reconnecting && !(await sameOAuthAccount(env, reconnecting, identity)))
		throw new CallbackFailure("different_account");
	if (!reconnecting) {
		await assertNotKiteDomain(env, identity.address);
		await assertMailbox(env, actor, pending.payload.mailboxId);
	}
	const servers = reconnecting
		? rowServers(reconnecting, info)
		: (pending.payload.testServers ?? { imap: { ...info.imap }, smtp: { ...info.smtp } });
	const login = {
		username: identity.address,
		password: "",
		accessToken: tokens.accessToken,
		oauthProvider: provider,
	};
	const test = await testImapConnection(env, { ...servers.imap, ...login });
	if (!test.ok) {
		logger.warn("external.oauth.imap_refused", { provider, kind: test.problem.kind });
		throw new CallbackFailure("imap_refused");
	}
	const sealedRefreshToken = await sealSetting(env, tokens.refreshToken);
	const accountId =
		reconnecting?.id ??
		(await insertOAuthAccount(env, actor, {
			info,
			payload: pending.payload,
			address: identity.address,
			servers,
			sealedRefreshToken,
			now: new Date(),
		}));
	if (reconnecting) await renewAccount(env, actor, accountId);
	await writeAccountOAuth(env, accountId, {
		authKind: info.authKind,
		sealedRefreshToken,
		sealedAccessToken: await sealSetting(env, tokens.accessToken),
		expiresAt: tokens.expiresAt,
		scopes: tokens.scopes,
		subject: identity.subject,
	});
	await saveBaseline(env, accountId, test.baseline);
	const sendProblem = await verifySending(env, accountId, { smtp: servers.smtp, username: identity.address }, login);
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
			address: identity.address,
			preset: reconnecting?.preset ?? oauthAccountPreset(provider, identity.address),
			signIn: provider,
			...(reconnecting
				? { signInChanged: true, passwordChanged: false }
				: { host: servers.imap.host, sendingVerified: !sendProblem }),
		},
	});
	return { ok: true, provider, accountId, reconnected: !!reconnecting };
}
