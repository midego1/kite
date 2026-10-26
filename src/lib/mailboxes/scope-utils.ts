import type { MailboxPermission } from "./types";

/** The `mailboxId` / `mailboxIds` query parameters of a message list, counts or navigation request. */
export type MailboxScopeRequest = {
	mailboxId?: string | null;
	/** Comma-separated ids: the All mailboxes view narrowed by its filter. */
	mailboxIds?: string | null;
};

/**
 * `ids` lists the mailboxes to read; an empty list means the caller has no accessible
 * mailbox and falls back to its own rows. `ok: false` names a mailbox the caller cannot
 * read, answered as 404 so ids do not leak.
 */
export type MailboxScope = { ok: true; ids: string[] } | { ok: false };

function parseMailboxIdList(value: string | null | undefined): string[] {
	if (!value) return [];
	return [
		...new Set(
			value
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean),
		),
	];
}

/** Which mailboxes a list reads: one, a chosen subset, or every mailbox the user can open. */
export function resolveMailboxScope(request: MailboxScopeRequest, accessibleIds: readonly string[]): MailboxScope {
	const accessible = new Set(accessibleIds);
	if (request.mailboxId)
		return accessible.has(request.mailboxId) ? { ok: true, ids: [request.mailboxId] } : { ok: false };
	const requested = parseMailboxIdList(request.mailboxIds);
	if (requested.length > 0)
		return requested.every((id) => accessible.has(id)) ? { ok: true, ids: requested } : { ok: false };
	return { ok: true, ids: [...accessibleIds] };
}

/** Bulk actions that only change the read state need read access; every other one moves or changes mail. */
export function actionNeedsManage(action: string): boolean {
	return action !== "read" && action !== "unread";
}

/** Only full access moves, deletes or files mail; read-only and send permissions stop at reading. */
export function canManageMailboxMail(permission: MailboxPermission | null | undefined): boolean {
	return permission === "full_access";
}

/**
 * Splits a selection by what the user may do to each message's mailbox. `permissionOf`
 * answers undefined for a mailbox the user cannot open, which is never allowed.
 */
export function splitByMailboxAccess<T extends { id: string; mailboxId?: string | null }>(
	items: readonly T[],
	action: string,
	permissionOf: (mailboxId: string) => MailboxPermission | undefined,
): { allowed: string[]; skipped: number } {
	const allowed: string[] = [];
	let skipped = 0;
	for (const item of items) {
		const permission = item.mailboxId ? permissionOf(item.mailboxId) : undefined;
		const ok = permission !== undefined && (!actionNeedsManage(action) || canManageMailboxMail(permission));
		if (ok) allowed.push(item.id);
		else skipped += 1;
	}
	return { allowed, skipped };
}

/** The one mailbox a selection belongs to, whose folders it may move to; null when it spans several. */
export function singleMailboxOf(mailboxIds: ReadonlyArray<string | null | undefined>): string | null {
	const distinct = new Set(mailboxIds.filter((id): id is string => !!id));
	return distinct.size === 1 ? [...distinct][0] : null;
}

/** The mailboxes the All mailboxes view shows: every accessible one except those its filter hides. */
export function visibleMailboxIds(mailboxIds: readonly string[], hiddenIds: readonly string[]): string[] {
	const hidden = new Set(hiddenIds);
	const visible = mailboxIds.filter((id) => !hidden.has(id));
	// Hiding every mailbox would leave an empty view with no way to tell why; show them all instead.
	return visible.length > 0 ? visible : [...mailboxIds];
}

/** The `mailboxIds` parameter for a view: none when it shows every mailbox, so the server reads them all. */
export function mailboxIdsParam(allIds: readonly string[], visibleIds: readonly string[]): string | null {
	if (visibleIds.length === allIds.length) return null;
	return visibleIds.join(",");
}

type MailboxCount = { mailboxId: string; total: number; unread: number; inbox: number };

/** The All mailboxes entry's numbers: the per-mailbox counts of the listed mailboxes added up. */
export function sumMailboxCounts(counts: readonly MailboxCount[], mailboxIds: readonly string[]) {
	const ids = new Set(mailboxIds);
	return counts.reduce(
		(sum, count) =>
			ids.has(count.mailboxId)
				? { total: sum.total + count.total, unread: sum.unread + count.unread, inbox: sum.inbox + count.inbox }
				: sum,
		{ total: 0, unread: 0, inbox: 0 },
	);
}

/** "A", "A and B", "A, B and C". */
export function formatMailboxNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What Empty Trash or Empty Spam does in a view: it empties the listed mailboxes the user may manage
 * that hold any such mail, never a read-only one, so the count and names it confirms are exactly those.
 */
export function planEmptyFolder(
	mailboxes: ReadonlyArray<{ id: string; name: string; permission?: MailboxPermission }>,
	countOf: (mailboxId: string) => number,
) {
	const targets = mailboxes
		.filter((mailbox) => canManageMailboxMail(mailbox.permission ?? "full_access"))
		.map((mailbox) => ({ id: mailbox.id, name: mailbox.name, count: countOf(mailbox.id) }))
		.filter((target) => target.count > 0);
	return {
		targets,
		total: targets.reduce((sum, target) => sum + target.count, 0),
		names: formatMailboxNames(targets.map((target) => target.name)),
	};
}

/** Read-only access never sends; the user's own mailboxes (no permission listed) and send grants do. */
export function canSendFromMailbox(permission: MailboxPermission | null | undefined): boolean {
	return permission !== "read_only";
}

/**
 * The mailbox a composer starts from: the first preferred one the user may still send from (the
 * choice in this composer, the last From used, the selected mailbox), else the first that can send.
 */
export function pickComposeMailbox<T extends { id: string }>(
	sendable: readonly T[],
	preferredIds: ReadonlyArray<string | null | undefined>,
): T | null {
	for (const id of preferredIds) {
		const mailbox = id ? sendable.find((item) => item.id === id) : undefined;
		if (mailbox) return mailbox;
	}
	return sendable[0] ?? null;
}
