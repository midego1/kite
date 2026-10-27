"use client";

import { useCallback } from "react";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { reportReadOnlySkipped } from "@/components/messages/list-action-toast";
import { useMessageAccess } from "@/components/messages/use-message-access";
import { actionNeedsManage } from "@/lib/mailboxes/scope-utils";

type ActionRunner = (action: BulkMessageAction, folderId?: string) => Promise<void>;

/**
 * The reader's view of a message's mailbox access: read-only shared mail can be read and marked
 * read, never moved or deleted, and `guard` refuses those actions (keys included) with a notice.
 */
export function useReadOnlyMail(mailboxId: string | null, { disabled, status }: { disabled: boolean; status: string }) {
	const access = useMessageAccess();
	const readOnly = !!access.mailboxOf(mailboxId) && !access.canManage(mailboxId);
	const guard = useCallback(
		(run: ActionRunner): ActionRunner =>
			async (action, folderId) => {
				if (readOnly && actionNeedsManage(action)) reportReadOnlySkipped(1, true);
				else await run(action, folderId);
			},
		[readOnly],
	);
	return {
		manageDisabled: disabled || readOnly,
		archiveDisabled: readOnly || status === "archived",
		guard,
	};
}
