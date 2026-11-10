import { getDb } from "@/db";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { OAUTH_SUPPORTED_SCOPES } from "./http";
import { findClient } from "./service";
import { checkAuthorizationRequest, mcpResourceUrl, type AuthorizationCheck, type OAuthClient } from "./utils";

type Params = { get(name: string): string | null; getAll?(name: string): string[]; keys?(): Iterable<string> };

/** RFC 6749 §3.1: no parameter may be sent twice, which would leave open which one counts. */
function repeatsParameter(params: Params): boolean {
	if (!params.getAll || !params.keys) return false;
	for (const name of params.keys()) if (params.getAll(name).length > 1) return true;
	return false;
}

/** An authorization request checked against its registration, for the consent screen and the decision route. */
export async function readAuthorization(
	env: CloudflareEnv,
	params: Params,
	issuer: string,
): Promise<{ check: AuthorizationCheck; client: OAuthClient | null }> {
	if (repeatsParameter(params))
		return { check: { kind: "fatal", message: "The app sent a parameter more than once." }, client: null };
	const client = await findClient(env, params.get("client_id"));
	return {
		check: checkAuthorizationRequest(params, client, mcpResourceUrl(issuer), OAUTH_SUPPORTED_SCOPES),
		client,
	};
}

/**
 * The mailboxes the consent screen offers: those the user can read, without disabled ones. The decision route accepts
 * no other.
 */
export async function offeredMailboxes(env: CloudflareEnv, user: Parameters<typeof listAccessibleMailboxes>[1]) {
	const mailboxes = await listAccessibleMailboxes(getDb(env), user);
	return mailboxes
		.filter((mailbox) => !mailbox.disabled)
		.map((mailbox) => ({ id: mailbox.id, address: `${mailbox.localPart}@${mailbox.hostname}` }));
}
