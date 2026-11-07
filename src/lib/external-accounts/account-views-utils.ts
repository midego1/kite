import { viaChipText } from "./via-utils";
import type { ExternalAccountPresetId } from "./types";

/**
 * A connected account as a sidebar view: the Inbox filtered by `via:` to mail that came in through it. A view is a
 * filter, not a mailbox; nothing is moved or stored for it.
 */
export type AccountViewEntry = {
	id: string;
	/** The mailbox the account delivers into, which the entry is listed under. */
	mailboxId: string;
	/** What the entry reads: the account's label, or its provider while the label is still the address. */
	label: string;
	address: string;
};

/** The accounts of a `GET /api/external-accounts` answer, reduced to what a view needs; anything unexpected is none. */
export function parseAccountViews(value: unknown): AccountViewEntry[] {
	const list = value && typeof value === "object" ? (value as { accounts?: unknown }).accounts : undefined;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item): AccountViewEntry[] => {
		if (!item || typeof item !== "object") return [];
		const { id, mailboxId, label, address, preset } = item as Record<string, unknown>;
		if (typeof id !== "string" || typeof mailboxId !== "string" || typeof address !== "string" || !address) return [];
		const via = {
			address,
			label: typeof label === "string" ? label : address,
			preset: (typeof preset === "string" ? preset : "other") as ExternalAccountPresetId,
		};
		return [{ id, mailboxId, label: viaChipText(via), address }];
	});
}

/** The entries that deliver into one of the mailboxes in view, in the order given. */
export function accountViewsIn(
	entries: readonly AccountViewEntry[],
	mailboxIds: readonly string[],
): AccountViewEntry[] {
	const visible = new Set(mailboxIds);
	return entries.filter((entry) => visible.has(entry.mailboxId));
}

/** Where an entry leads: the Inbox with the account in the address, so a new tab or a reload opens the same view. */
export function accountViewHref(entry: Pick<AccountViewEntry, "address">): string {
	return `/inbox?via=${encodeURIComponent(entry.address)}`;
}

/** The entry whose view is open: the Inbox (or a message opened from it) filtered to that account's address. */
export function activeAccountView(
	entries: readonly AccountViewEntry[],
	view: string | null,
	pathname: string,
): AccountViewEntry | null {
	if (!view || (pathname !== "/inbox" && !pathname.startsWith("/inbox/"))) return null;
	const address = view.trim().toLowerCase();
	return entries.find((entry) => entry.address.toLowerCase() === address) ?? null;
}

/**
 * What the open view is called: the account's label (or provider) once the accounts are known, else the address the
 * view was opened with, so a view opened from a link has a name from the first paint.
 */
export function openViewName(entries: readonly AccountViewEntry[] | undefined, view: string): string {
	const address = view.trim().toLowerCase();
	return entries?.find((entry) => entry.address.toLowerCase() === address)?.label ?? view;
}

/**
 * Whether the open view's account is one of the user's own that delivers into a mailbox that is not in view
 * (`inView` are the entries of the mailboxes in view): the view would list nothing of the mailbox they switched to.
 * An address that is none of the user's accounts is left alone.
 */
export function isAccountOutside(
	accounts: readonly AccountViewEntry[],
	inView: readonly AccountViewEntry[],
	view: string,
): boolean {
	const address = view.trim().toLowerCase();
	const own = (entry: AccountViewEntry) => entry.address.toLowerCase() === address;
	return accounts.some(own) && !inView.some(own);
}

/**
 * The link with the open view carried in it (`?via=`), so opening a message, going to the next or previous one, leaving
 * it and going back keep the list narrowed to the account. Without a view the link is unchanged.
 */
export function hrefWithView(href: string, view: string | null): string {
	if (!view) return href;
	const hash = href.indexOf("#");
	const base = hash === -1 ? href : href.slice(0, hash);
	const fragment = hash === -1 ? "" : href.slice(hash);
	const [path, query = ""] = base.split("?");
	const params = new URLSearchParams(query);
	params.set("via", view);
	return `${path}?${params.toString()}${fragment}`;
}
