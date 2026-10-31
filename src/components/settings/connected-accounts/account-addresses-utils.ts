import { authFetch } from "@/lib/auth/client";
import type { ExternalAccountView, ExternalIdentityView } from "@/lib/external-accounts/types";
import { readJson } from "./connected-accounts-utils";

const identitiesPath = (accountId: string, identityId?: string, action?: "code" | "verify") =>
	[
		`/api/external-accounts/${encodeURIComponent(accountId)}/identities`,
		identityId ? `/${encodeURIComponent(identityId)}` : "",
		action ? `/${action}` : "",
	].join("");

async function post<T>(path: string, body: Record<string, unknown>, fallback: string): Promise<T> {
	const response = await authFetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return readJson<T>(response, fallback);
}

/** Adds an address to the account and mails it a code; answers the address's id. */
export async function addIdentity(accountId: string, address: string): Promise<string> {
	const data = await post<{ identityId: string }>(identitiesPath(accountId), { address }, "Could not send the code");
	return data.identityId;
}

export async function resendIdentityCode(accountId: string, identityId: string): Promise<void> {
	await post(identitiesPath(accountId, identityId, "code"), {}, "Could not send a new code");
}

export async function verifyIdentity(accountId: string, identityId: string, code: string): Promise<void> {
	await post(identitiesPath(accountId, identityId, "verify"), { code }, "Could not check the code");
}

export async function removeIdentity(accountId: string, identityId: string): Promise<void> {
	const response = await authFetch(identitiesPath(accountId, identityId), { method: "DELETE" });
	await readJson(response, "Could not remove the address");
}

/** The aliases of an account: its addresses other than the one it signs in with. */
export function aliasesOf(account: Pick<ExternalAccountView, "identities">): ExternalIdentityView[] {
	return account.identities.filter((identity) => !identity.accountAddress);
}

/**
 * The verification under way for the account's own address, when its sign-in does not prove it: null when it needs
 * no code (proven, or already verified), else its row once a code was asked for.
 */
export function ownAddressVerification(
	account: Pick<ExternalAccountView, "identities" | "sending">,
): { identity: ExternalIdentityView | null } | null {
	if (account.sending.block !== "alias" && account.sending.block !== "unproven") return null;
	const identity = account.identities.find((entry) => entry.accountAddress) ?? null;
	return identity?.state === "verified" ? null : { identity };
}

/** Where an address stands, in plain words. */
export const IDENTITY_STATE_LABELS: Record<ExternalIdentityView["state"], string> = {
	verified: "Verified",
	pending: "Code sent",
	unverified: "Not verified",
};
