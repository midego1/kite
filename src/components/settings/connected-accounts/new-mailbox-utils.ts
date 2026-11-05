import { authFetch } from "@/lib/auth/client";
import { canManageOwnMailboxes } from "@/app/(admin)/mailboxes/utils";
import { clearMailboxesCache, MAILBOXES_CHANGED_EVENT } from "@/components/mailbox-provider-utils";

/** The "Mail goes to" choice that creates a mailbox for the account instead of picking an existing one. */
export const NEW_MAILBOX_VALUE = "__new__";

/** A domain the user may create mailboxes on (`GET /api/domains`: their own, or their admin's for a mailbox manager). */
export type UsableDomain = { id: string; hostname: string };

/** A mailbox the dialog created: kept when connecting failed, so the person can reuse or delete it. */
export type CreatedMailbox = { id: string; address: string };

export type NewMailboxState = { localPart: string; domainId: string; edited: boolean };

const LOCAL_PART_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** Whether the connect dialog offers a mailbox of its own: only to people who may create mailboxes, on a domain they may use. */
export function canOfferNewMailbox(
	user: { role: string; canManageMailboxes: boolean } | null | undefined,
	domains: readonly UsableDomain[],
): boolean {
	return canManageOwnMailboxes(user) && domains.length > 0;
}

/** Lower-case letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit: what a mailbox address keeps. */
function cleanPart(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/**
 * The mailbox name offered for a connected address: the part before the `@` and the provider's name, so
 * `mdgooijer@gmail.com` becomes `mdgooijer-gmail`. A name that is taken on the domain gets `-2`, `-3`, … .
 */
export function suggestMailboxLocalPart(address: string, taken: ReadonlySet<string> = new Set()): string {
	const [local = "", host = ""] = address.trim().split("@");
	const provider = cleanPart(host.split(".")[0] ?? "");
	const base = cleanPart([cleanPart(local), provider].filter(Boolean).join("-"))
		.slice(0, 56)
		.replace(/[^a-z0-9]+$/, "");
	if (!base) return "";
	if (!taken.has(base)) return base;
	for (let counter = 2; counter < 1000; counter += 1) if (!taken.has(`${base}-${counter}`)) return `${base}-${counter}`;
	return base;
}

/** What is wrong with a typed mailbox name, in words; null when it can be created. */
export function mailboxLocalPartProblem(localPart: string, taken: ReadonlySet<string>): string | null {
	const value = localPart.trim().toLowerCase();
	if (!value) return "Enter a name for the mailbox.";
	if (!LOCAL_PART_PATTERN.test(value))
		return "Use letters, digits, dots, dashes and underscores, starting and ending with a letter or digit (up to 64 characters).";
	if (taken.has(value)) return "That address is already a mailbox.";
	return null;
}

/** `GET /api/domains`: the domains to offer; none (so nothing new is shown) when the request fails. */
export async function fetchUsableDomains(): Promise<UsableDomain[]> {
	const response = await authFetch("/api/domains");
	if (!response.ok) return [];
	const data = (await response.json().catch(() => ({}))) as { domains?: UsableDomain[] };
	return (data.domains ?? []).map((domain) => ({ id: domain.id, hostname: domain.hostname }));
}

/** The mailbox list everywhere follows a created or deleted mailbox (sidebar, composer's From menu). */
function mailboxesChanged() {
	clearMailboxesCache();
	window.dispatchEvent(new Event(MAILBOXES_CHANGED_EVENT));
}

/** Creates a personal mailbox through the same route as Settings → Mailboxes (permissions, routing rule, limits). */
export async function createAccountMailbox(input: {
	domainId: string;
	localPart: string;
}): Promise<{ id: string; address: string }> {
	const response = await authFetch("/api/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			domainId: input.domainId,
			localPart: input.localPart.trim().toLowerCase(),
			type: "personal",
		}),
	});
	const data = (await response.json().catch(() => ({}))) as { id?: string; address?: string; error?: unknown };
	if (!response.ok || !data.id || !data.address)
		throw new Error(typeof data.error === "string" ? data.error : "Could not create the mailbox");
	mailboxesChanged();
	return { id: data.id, address: data.address };
}

/** Deletes a mailbox the dialog created only while the server can still prove it is empty and unconnected. */
export async function deleteAccountMailbox(id: string): Promise<void> {
	const response = await authFetch(`/api/mailboxes/${encodeURIComponent(id)}?onlyIfEmpty=1`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: unknown };
		throw new Error(typeof data.error === "string" ? data.error : "Could not delete the mailbox");
	}
	mailboxesChanged();
}
