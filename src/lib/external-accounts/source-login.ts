import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { importJobs } from "@/db/schema/import-jobs";
import type { HostSourceLogin, HostSourceLoginRequest } from "@/lib/modules/host-types";
import type { CapabilityCallContext, ModuleId } from "@/lib/modules/module-types";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { CONNECT_REFUSAL_TEXT, connectRefusal } from "./access";
import { externalAccountTablesReady } from "./errors";

const REMOVED: HostSourceLogin = { ok: false, reason: "removed", message: "The account was removed" };

/** Import job states a run works in; a paused, finished or cancelled job gets no login. */
const RUNNING_JOB = ["pending", "running"] as const;

const reconnect = (address: string): HostSourceLogin => ({
	ok: false,
	reason: "auth_failed",
	message: `Kite cannot sign in to ${address}. Reconnect it under Settings → Connected accounts.`,
});

/**
 * Whose account a request may open, decided in core: for `jobId`, the account and owner of that active import job
 * (and, with a session viewer, only the viewer's own job); for `accountId`, only the session viewer's own account.
 * A background caller (no viewer) can never name an account directly.
 */
async function resolveTarget(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	request: HostSourceLoginRequest,
): Promise<{ accountId: string; userId: string } | null> {
	if (request && "jobId" in request && typeof request.jobId === "string") {
		const [job] = await getDb(env)
			.select({ userId: importJobs.userId, accountId: importJobs.externalAccountId })
			.from(importJobs)
			.where(and(eq(importJobs.id, request.jobId), inArray(importJobs.status, [...RUNNING_JOB])))
			.limit(1);
		if (!job?.accountId || (ctx.viewer && ctx.viewer.userId !== job.userId)) return null;
		return { accountId: job.accountId, userId: job.userId };
	}
	if (request && "accountId" in request && typeof request.accountId === "string" && ctx.viewer)
		return { accountId: request.accountId, userId: ctx.viewer.userId };
	return null;
}

/**
 * `moduleHost.accounts.sourceLogin` (spec §9.2): the login of a connected account for one run of an import from it,
 * for the import module only, after checking whose account it is and that it may be used. The password is opened
 * here and returned to the caller only; nothing is copied into the job, so removing the account stops it.
 */
export async function externalSourceLogin(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	moduleId: ModuleId,
	request: HostSourceLoginRequest,
): Promise<HostSourceLogin> {
	if (moduleId !== "import")
		return { ok: false, reason: "not_allowed", message: "Only imports use connected accounts" };
	if (!(await externalAccountTablesReady(env))) return REMOVED;
	const target = await resolveTarget(env, ctx, request);
	if (!target) return REMOVED;
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
		.where(and(eq(externalAccounts.id, target.accountId), eq(externalAccounts.userId, target.userId)))
		.limit(1);
	if (!account) return REMOVED;
	const refusal = await connectRefusal(env, target.userId);
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
			.where(eq(externalAccounts.id, target.accountId));
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
