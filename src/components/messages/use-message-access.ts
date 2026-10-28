"use client";

import { useCallback, useMemo } from "react";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { canManageMailboxMail, splitByMailboxAccess } from "@/lib/mailboxes/scope-utils";
import type { MailboxPermission } from "@/lib/mailboxes/types";

/**
 * What the user may do to each listed message, from the access level of its own mailbox, so the
 * All mailboxes view mirrors the server: read-only shared mail can be read, not moved or deleted.
 */
export function useMessageAccess() {
	const { mailboxes, allMailboxes } = useSelectedMailbox();
	const byId = useMemo(() => new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox])), [mailboxes]);
	const mailboxOf = useCallback(
		(mailboxId: string | null | undefined): MailboxOption | undefined => (mailboxId ? byId.get(mailboxId) : undefined),
		[byId],
	);
	// Mailboxes listed without a permission are the user's own.
	const permissionOf = useCallback(
		(mailboxId: string): MailboxPermission | undefined => {
			const mailbox = byId.get(mailboxId);
			return mailbox ? (mailbox.permission ?? "full_access") : undefined;
		},
		[byId],
	);
	const canManage = useCallback(
		(mailboxId: string | null | undefined) => !!mailboxId && canManageMailboxMail(permissionOf(mailboxId)),
		[permissionOf],
	);
	const split = useCallback(
		<T extends { id: string; mailboxId?: string | null; status?: string }>(items: readonly T[], action: string) =>
			splitByMailboxAccess(items, action, permissionOf),
		[permissionOf],
	);
	return { showMailboxLabels: allMailboxes, mailboxOf, canManage, split };
}
