import type { ExternalAccountStatus } from "@/lib/external-accounts/types";

/** An account the sidebar notice names. */
export type AttentionAccount = { id: string; address: string; status: ExternalAccountStatus };

/** The accounts of a `/api/external-accounts/attention` answer; anything unexpected reads as none. */
export function parseAttentionAccounts(value: unknown): AttentionAccount[] {
	const list = value && typeof value === "object" ? (value as { accounts?: unknown }).accounts : undefined;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const { id, address, status } = item as Record<string, unknown>;
		return typeof id === "string" && typeof address === "string" && typeof status === "string"
			? [{ id, address, status: status as ExternalAccountStatus }]
			: [];
	});
}

/** What the notice says (spec §6.5): sign-in failures first, since only the owner can fix them. */
export function connectedAccountsBannerContent(accounts: AttentionAccount[]): { title: string; body: string } {
	const signIn = accounts.filter((account) => account.status === "auth_failed");
	if (signIn.length)
		return {
			title:
				signIn.length === 1
					? `Sign-in failed for ${signIn[0].address}`
					: `Sign-in failed for ${signIn.length} accounts`,
			body: "Reconnect to keep its new mail arriving in Kite.",
		};
	return {
		title:
			accounts.length === 1
				? `Kite cannot check ${accounts[0].address}`
				: `Kite cannot check ${accounts.length} connected accounts`,
		body: "New mail from it is not arriving. Open Connected accounts to see why.",
	};
}
