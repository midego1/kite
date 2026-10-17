import type { Mailbox } from "./types";

export function getMailboxAddress(mailbox: Pick<Mailbox, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getMailboxName(mailbox: Pick<Mailbox, "displayName" | "localPart">): string {
	return mailbox.displayName?.trim() || mailbox.localPart;
}

export type MailboxesBase = "/mailboxes" | "/settings/mailboxes";

/** The list and editor serve both Admin → Mailboxes and Settings → Mailboxes; links stay in the area they were opened from. */
export function getMailboxesBase(pathname: string | null | undefined): MailboxesBase {
	return pathname === "/settings/mailboxes" || pathname?.startsWith("/settings/mailboxes/")
		? "/settings/mailboxes"
		: "/mailboxes";
}

/**
 * Settings lists only the mailboxes the user owns, which are the ones the API lets them
 * rename, give aliases and delete; Admin lists every mailbox the admin can open.
 */
export function listedMailboxes<T extends Pick<Mailbox, "userId">>(
	mailboxes: T[],
	base: MailboxesBase,
	userId: string | undefined,
): T[] {
	if (base === "/mailboxes") return mailboxes;
	return userId ? mailboxes.filter((mailbox) => mailbox.userId === userId) : [];
}

/** The mailbox ID from `/mailboxes/[id]` or from the optional catch-all `/settings/mailboxes/[[...id]]`. */
export function mailboxIdParam(id: string | string[] | undefined): string {
	return (Array.isArray(id) ? id[0] : id) ?? "";
}

/** Who may open Settings → Mailboxes: members with the mailbox grant, and admins, who manage mailboxes anyway. */
export function canManageOwnMailboxes(user: { role: string; canManageMailboxes: boolean } | null | undefined): boolean {
	return !!user && (user.canManageMailboxes || user.role === "admin");
}
