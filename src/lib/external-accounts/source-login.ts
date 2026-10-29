import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import type { HostSourceLogin, HostSourceLoginRequest } from "@/lib/modules/host-types";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { CONNECT_REFUSAL_TEXT, connectRefusal } from "./access";
import { externalAccountTablesReady } from "./errors";

const REMOVED: HostSourceLogin = { ok: false, reason: "removed", message: "The account was removed" };

const reconnect = (address: string): HostSourceLogin => ({
	ok: false,
	reason: "auth_failed",
	message: `Kite cannot sign in to ${address}. Reconnect it under Settings → Connected accounts.`,
});

/**
 * `moduleHost.accounts.sourceLogin` (spec §9.2): the login of a connected account for one run of a job that imports
 * from it, after checking that the account belongs to the job's user and may be used. The password is opened here
 * and returned to the caller only; nothing is copied into the job, so removing the account stops it.
 */
export async function externalSourceLogin(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	request: HostSourceLoginRequest,
): Promise<HostSourceLogin> {
	if (!request?.accountId || !request.userId) return REMOVED;
	// A session caller may only ask for their own accounts; background runs act for the job's owner.
	if (ctx.viewer && ctx.viewer.userId !== request.userId) return REMOVED;
	if (!(await externalAccountTablesReady(env))) return REMOVED;
	const db = getDb(env);
	const [account] = await db
		.select({
			address: externalAccounts.address,
			imapHost: externalAccounts.imapHost,
			imapPort: externalAccounts.imapPort,
			imapSecurity: externalAccounts.imapSecurity,
			username: externalAccounts.username,
			secret: externalAccounts.secret,
			status: externalAccounts.status,
		})
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, request.accountId), eq(externalAccounts.userId, request.userId)))
		.limit(1);
	if (!account) return REMOVED;
	const refusal = await connectRefusal(env, request.userId);
	if (refusal) return { ok: false, reason: "not_allowed", message: CONNECT_REFUSAL_TEXT[refusal] };
	if (!account.secret || account.status === "auth_failed" || account.status === "disabled")
		return reconnect(account.address);
	let password: string | null;
	try {
		password = await openSetting(env, account.secret);
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		await db
			.update(externalAccounts)
			.set({
				status: "auth_failed",
				lastError: "The saved password can no longer be opened. Reconnect the account.",
				updatedAt: new Date(),
			})
			.where(eq(externalAccounts.id, request.accountId));
		return reconnect(account.address);
	}
	if (!password) return reconnect(account.address);
	return {
		ok: true,
		login: {
			host: account.imapHost,
			port: account.imapPort,
			security: account.imapSecurity,
			username: account.username,
			auth: { kind: "password", password },
		},
	};
}
