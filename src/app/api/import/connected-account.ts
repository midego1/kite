import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import { normalizeTimeZone } from "@/lib/time/utils";

type ImportUser = { id: string; role: string; isPrimaryAdmin: boolean; timeZone: string | null };

/** The IMAP login fields of an import request, as the form would have sent them. */
type SourceFields = { host: string; port: number; secure: boolean; username: string; password: string };

export type ConnectedSource = { fields: SourceFields; externalAccountId: string };

/**
 * An import from a connected account (spec §9.2): the request names `accountId` instead of typing a password, and
 * core hands over the account's login if it is the user's own and may be used. The returned fields replace whatever
 * the request carried; the job keeps only the account id, never the password.
 */
async function connectedAccountSource(
	user: ImportUser,
	accountId: unknown,
): Promise<ConnectedSource | { error: Response } | null> {
	if (accountId === undefined || accountId === null || accountId === "") return null;
	if (typeof accountId !== "string") return { error: Response.json({ error: "Invalid account" }, { status: 400 }) };
	const ctx = buildCallContext({
		trigger: "api",
		viewer: { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		timeZone: normalizeTimeZone(user.timeZone),
	});
	const answer = await moduleHost.accounts.sourceLogin(ctx, { accountId, userId: user.id });
	if (!answer.ok) {
		const status = answer.reason === "removed" ? 404 : 409;
		return { error: Response.json({ error: answer.message, code: answer.reason.toUpperCase() }, { status }) };
	}
	const { login } = answer;
	return {
		externalAccountId: accountId,
		fields: {
			host: login.host,
			port: login.port,
			secure: login.security === "tls",
			username: login.username,
			password: login.auth.password,
		},
	};
}

/** The request body with a connected account's login filled in, and the account; or the refusal to answer. */
export async function resolveImportSource<T extends { accountId?: unknown }>(
	user: ImportUser,
	body: T,
): Promise<{ body: T; source: ConnectedSource | null } | { error: Response }> {
	const source = await connectedAccountSource(user, body.accountId);
	if (source && "error" in source) return source;
	return { body: source ? { ...body, ...source.fields } : body, source };
}

/** What a job keeps of its source: a typed password (sealed by the job), or only the connected account's id. */
export function jobSourceFields(source: ConnectedSource | null, password: string) {
	return { password: source ? "" : password, externalAccountId: source?.externalAccountId ?? null };
}
