import { and, count, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { externalIdentities } from "@/db/schema/external-accounts";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { auditExternalAccount } from "./audit";
import { ExternalAccountRefusal, migrationPending } from "./errors";
import {
	CODE_WINDOW_MS,
	CODES_PER_ADDRESS,
	CODES_PER_USER,
	generateIdentityCode,
	hashIdentityCode,
	IDENTITY_CODE_TTL_MS,
	identityCodeMail,
	MAX_CODE_ATTEMPTS,
	MAX_IDENTITIES_PER_ACCOUNT,
	normalizeIdentityCode,
	parseIdentityAddress,
	parseIdentityName,
	sameCodeHash,
} from "./identity-code-utils";
import { externalIdentitiesReady, type ExternalIdentityRow } from "./identity-store";
import type { ExternalAccountRow } from "./serialize-utils";
import { assertAllowed, assertNotKiteDomain, ownAccount, ownView, type AccountActor } from "./service";
import type { ExternalAccountView } from "./types";

const log = createLogger("external");

async function assertReady(env: CloudflareEnv): Promise<void> {
	if (!(await externalIdentitiesReady(env))) throw migrationPending();
}

/** One of the account's addresses; another account's or another user's answers like a missing one. */
async function ownIdentity(env: CloudflareEnv, accountId: string, identityId: string): Promise<ExternalIdentityRow> {
	const [row] = await getDb(env)
		.select()
		.from(externalIdentities)
		.where(and(eq(externalIdentities.id, identityId), eq(externalIdentities.accountId, accountId)))
		.limit(1);
	if (!row) throw new ExternalAccountRefusal(404, "Address not found");
	return row;
}

/** The account's own address is proven by signing in (a known provider, user name = address): no code applies. */
const provenBySignIn = (account: ExternalAccountRow) =>
	account.preset !== "other" && account.username.trim().toLowerCase() === account.address;

const auditFor = (account: ExternalAccountRow, identity: Pick<ExternalIdentityRow, "id" | "address">) => ({
	accountId: account.id,
	identityId: identity.id,
	address: identity.address,
	accountAddress: identity.address === account.address,
});

/**
 * Counts one code mail against the user's and the address's limits (429 past either). As with connection tests, the
 * request is recorded first and counted afterwards, including it, so parallel requests can never all see room; every
 * request counts, refused ones too. The address limit holds whoever asks, so no number of users can flood one inbox.
 */
async function countCodeRequest(
	env: CloudflareEnv,
	actorId: string,
	account: ExternalAccountRow,
	identity: ExternalIdentityRow,
): Promise<void> {
	await auditExternalAccount(env, {
		actorUserId: actorId,
		action: "external_identity.code_requested",
		mailboxId: account.mailboxId,
		metadata: auditFor(account, identity),
	});
	const since = new Date(Date.now() - CODE_WINDOW_MS);
	const db = getDb(env);
	const recent = and(eq(auditLogs.action, "external_identity.code_requested"), gt(auditLogs.createdAt, since));
	const [[byUser], [byAddress]] = await Promise.all([
		db
			.select({ requests: count() })
			.from(auditLogs)
			.where(and(recent, eq(auditLogs.actorUserId, actorId))),
		db
			.select({ requests: count() })
			.from(auditLogs)
			.where(and(recent, sql`json_extract(${auditLogs.metadata}, '$.address') = ${identity.address}`)),
	]);
	if ((byUser?.requests ?? 0) > CODES_PER_USER || (byAddress?.requests ?? 0) > CODES_PER_ADDRESS)
		throw new ExternalAccountRefusal(
			429,
			"Too many verification codes were asked for. Wait an hour before asking for another.",
			"RATE_LIMITED",
		);
}

/**
 * Mails a new code to the address and nowhere else (spec §7.2): six random digits, stored only as an HMAC, valid 30
 * minutes and for `MAX_CODE_ATTEMPTS` tries, replacing any earlier code. It goes out as system mail (no Sent copy,
 * no webhooks) with a fixed text; when the install cannot send mail the code is dropped again and the user told.
 */
async function mailCode(
	env: CloudflareEnv,
	actorId: string,
	account: ExternalAccountRow,
	identity: ExternalIdentityRow,
): Promise<void> {
	await countCodeRequest(env, actorId, account, identity);
	const code = generateIdentityCode();
	const db = getDb(env);
	await db
		.update(externalIdentities)
		.set({
			codeHash: await hashIdentityCode(env.APP_ENCRYPTION_KEY ?? "", identity.id, code),
			codeExpiresAt: new Date(Date.now() + IDENTITY_CODE_TTL_MS),
			attempts: 0,
		})
		.where(and(eq(externalIdentities.id, identity.id), isNull(externalIdentities.verifiedAt)));
	let sent = false;
	try {
		sent = await sendSystemEmail(env, { to: identity.address, ...identityCodeMail(identity.address, code) });
	} catch (error) {
		log.warn("external.identity_code_failed", {
			accountId: account.id,
			identityId: identity.id,
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	if (sent) return;
	await db
		.update(externalIdentities)
		.set({ codeHash: null, codeExpiresAt: null, attempts: 0 })
		.where(and(eq(externalIdentities.id, identity.id), isNull(externalIdentities.verifiedAt)));
	throw new ExternalAccountRefusal(
		503,
		"Kite could not send the verification code. Sending mail needs a domain that can send; ask your admin, then try again.",
		"CODE_NOT_SENT",
	);
}

/**
 * Adds an address to an account and mails it a code (spec §7.2): a provider alias, or the account's own address when
 * its sign-in does not prove it. An address on one of this install's domains is refused, as for connecting, and the
 * account needs an SMTP server, the one the address will be sent through. Asking again for an address waiting for its
 * code mails a new one.
 */
export async function addExternalIdentity(
	env: CloudflareEnv,
	actor: AccountActor,
	accountId: string,
	body: Record<string, unknown>,
): Promise<{ account: ExternalAccountView; identityId: string }> {
	const account = await ownAccount(env, actor.id, accountId);
	await assertAllowed(env, actor.id);
	await assertReady(env);
	const address = parseIdentityAddress(body.address);
	if (!address) throw new ExternalAccountRefusal(400, "Enter one email address");
	if (!account.smtpHost)
		throw new ExternalAccountRefusal(400, "Add the account's SMTP server first: Kite sends through it.", "NO_SMTP");
	if (address === account.address && provenBySignIn(account))
		throw new ExternalAccountRefusal(
			409,
			"Signing in already proves this address; it needs no code.",
			"NO_CODE_NEEDED",
		);
	if (address !== account.address) await assertNotKiteDomain(env, address);
	const db = getDb(env);
	const find = async () =>
		(
			await db
				.select()
				.from(externalIdentities)
				.where(and(eq(externalIdentities.accountId, account.id), eq(externalIdentities.address, address)))
				.limit(1)
		)[0];
	let identity = await find();
	if (identity?.verifiedAt)
		throw new ExternalAccountRefusal(409, "This address is already verified", "ALREADY_VERIFIED");
	if (!identity) {
		const [held] = await db
			.select({ total: count() })
			.from(externalIdentities)
			.where(eq(externalIdentities.accountId, account.id));
		if ((held?.total ?? 0) >= MAX_IDENTITIES_PER_ACCOUNT)
			throw new ExternalAccountRefusal(
				409,
				`An account can have at most ${MAX_IDENTITIES_PER_ACCOUNT} other addresses. Remove one first.`,
				"TOO_MANY_ADDRESSES",
			);
		await db
			.insert(externalIdentities)
			.values({
				id: newId("xid"),
				accountId: account.id,
				address,
				displayName: parseIdentityName(body.displayName),
				createdAt: new Date(),
			})
			// Two requests for the same address make one row.
			.onConflictDoNothing();
		identity = (await find())!;
	}
	await mailCode(env, actor.id, account, identity);
	return { account: await ownView(env, actor.id, account.id), identityId: identity.id };
}

/** **Send a new code** for an address still waiting for one. */
export async function resendExternalIdentityCode(
	env: CloudflareEnv,
	actor: AccountActor,
	accountId: string,
	identityId: string,
): Promise<{ account: ExternalAccountView }> {
	const account = await ownAccount(env, actor.id, accountId);
	await assertAllowed(env, actor.id);
	await assertReady(env);
	const identity = await ownIdentity(env, account.id, identityId);
	if (identity.verifiedAt)
		throw new ExternalAccountRefusal(409, "This address is already verified", "ALREADY_VERIFIED");
	await mailCode(env, actor.id, account, identity);
	return { account: await ownView(env, actor.id, account.id) };
}

/** Wrong codes in a burst, per user (the login limiter's budget), on top of the attempts each code allows. */
async function allowVerify(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `external-identity-verify:${userId}` })).success;
	} catch (error) {
		console.warn("external.identity_rate_limiter_unavailable", error instanceof Error ? error.name : "unknown");
		return true;
	}
}

const CODE_GONE = () =>
	new ExternalAccountRefusal(400, "This code is no longer valid. Send a new code.", "CODE_EXPIRED");

/**
 * Checks a code. One attempt is taken from the code before it is compared, in one statement that also checks the
 * expiry and the limit, so parallel guesses can never get past `MAX_CODE_ATTEMPTS`; the hashes are compared in
 * constant time. The right code verifies the address and is cleared (single use); the last wrong one drops the code.
 */
export async function verifyExternalIdentity(
	env: CloudflareEnv,
	actor: AccountActor,
	accountId: string,
	identityId: string,
	body: Record<string, unknown>,
): Promise<{ account: ExternalAccountView }> {
	const account = await ownAccount(env, actor.id, accountId);
	await assertAllowed(env, actor.id);
	await assertReady(env);
	if (!(await allowVerify(env, actor.id)))
		throw new ExternalAccountRefusal(429, "Too many attempts. Wait a minute and try again.", "RATE_LIMITED");
	const code = normalizeIdentityCode(body.code);
	if (!code) throw new ExternalAccountRefusal(400, "Enter the 6-digit code from the email");
	const identity = await ownIdentity(env, account.id, identityId);
	if (identity.verifiedAt) return { account: await ownView(env, actor.id, account.id) };
	const db = getDb(env);
	const now = new Date();
	const [claimed] = await db
		.update(externalIdentities)
		.set({ attempts: sql`${externalIdentities.attempts} + 1` })
		.where(
			and(
				eq(externalIdentities.id, identity.id),
				isNull(externalIdentities.verifiedAt),
				isNotNull(externalIdentities.codeHash),
				gt(externalIdentities.codeExpiresAt, now),
				lt(externalIdentities.attempts, MAX_CODE_ATTEMPTS),
			),
		)
		.returning({ codeHash: externalIdentities.codeHash, attempts: externalIdentities.attempts });
	if (!claimed?.codeHash) throw CODE_GONE();
	const candidate = await hashIdentityCode(env.APP_ENCRYPTION_KEY ?? "", identity.id, code);
	if (!sameCodeHash(claimed.codeHash, candidate)) {
		const left = MAX_CODE_ATTEMPTS - claimed.attempts;
		if (left <= 0)
			await db
				.update(externalIdentities)
				.set({ codeHash: null, codeExpiresAt: null })
				.where(and(eq(externalIdentities.id, identity.id), eq(externalIdentities.codeHash, claimed.codeHash)));
		await auditExternalAccount(env, {
			actorUserId: actor.id,
			action: "external_identity.verify_failed",
			mailboxId: account.mailboxId,
			metadata: { ...auditFor(account, identity), attemptsLeft: Math.max(left, 0) },
		});
		throw new ExternalAccountRefusal(
			400,
			left > 0
				? `That code is not right. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
				: "That code is not right, and it was tried too often. Send a new code.",
			"CODE_WRONG",
		);
	}
	const [verified] = await db
		.update(externalIdentities)
		.set({ verifiedAt: now, codeHash: null, codeExpiresAt: null, attempts: 0 })
		.where(
			and(
				eq(externalIdentities.id, identity.id),
				eq(externalIdentities.codeHash, claimed.codeHash),
				isNull(externalIdentities.verifiedAt),
			),
		)
		.returning({ id: externalIdentities.id });
	// Another request used the code first: it verified the address, or a new code replaced this one.
	if (!verified) {
		const current = await ownIdentity(env, account.id, identity.id);
		if (!current.verifiedAt) throw CODE_GONE();
		return { account: await ownView(env, actor.id, account.id) };
	}
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_identity.verified",
		mailboxId: account.mailboxId,
		metadata: auditFor(account, identity),
	});
	return { account: await ownView(env, actor.id, account.id) };
}

/**
 * Removes an address from an account: it leaves the From menu at once, and sends from it still waiting (undo,
 * scheduled) fail when they run. Allowed whatever the owner's permission, like removing the account.
 */
export async function removeExternalIdentity(
	env: CloudflareEnv,
	actor: AccountActor,
	accountId: string,
	identityId: string,
): Promise<{ account: ExternalAccountView }> {
	const account = await ownAccount(env, actor.id, accountId);
	await assertReady(env);
	const identity = await ownIdentity(env, account.id, identityId);
	await getDb(env)
		.delete(externalIdentities)
		.where(and(eq(externalIdentities.id, identity.id), eq(externalIdentities.accountId, account.id)));
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		action: "external_identity.revoked",
		mailboxId: account.mailboxId,
		metadata: { ...auditFor(account, identity), wasVerified: !!identity.verifiedAt },
	});
	return { account: await ownView(env, actor.id, account.id) };
}
