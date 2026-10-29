import type { MailboxOption } from "./mailbox-provider";

export function getMailboxAddress(mailbox: MailboxOption): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getMailboxName(mailbox: MailboxOption): string {
	return mailbox.displayName ?? mailbox.localPart;
}

export function getAccountInitial(value: string): string {
	return value.trim().slice(0, 1).toUpperCase() || "M";
}

export function isAdminPath(pathname: string): boolean {
	return (
		pathname === "/admin" ||
		pathname.startsWith("/mailboxes") ||
		pathname.startsWith("/domains") ||
		pathname.startsWith("/api-keys") ||
		pathname.startsWith("/webhooks") ||
		pathname.startsWith("/activity") ||
		pathname.startsWith("/backups")
	);
}

/** Where the account menu goes when it opens upward from `element`: above it, as tall as the window leaves room for. */
export function menuAnchorAbove(element: HTMLElement | null): { bottom: number; maxHeight: number } | null {
	if (!element) return null;
	const top = element.getBoundingClientRect().top;
	return { bottom: window.innerHeight - top + 8, maxHeight: Math.max(160, top - 8 - 12) };
}
