"use client";

import toast from "react-hot-toast";
import { PartialBulkActionError } from "./bulk-action-batch-utils";
import { t } from "@/lib/i18n/translator";

const LIST_ACTION_ERROR = "Could not update the messages. Please try again.";

/**
 * Tells the user a list or row action failed; one toast id, so repeated failures do not stack. A
 * `PartialBulkActionError` (a later batch of a large bulk action failed or was declined after earlier ones
 * already went through) says how far it got instead of the plain message.
 */
export function reportListActionError(error: unknown) {
	console.error(error);
	if (error instanceof PartialBulkActionError && error.completed > 0) {
		toast.error(
			t("{completed} of {total} done. The rest could not be updated; please try again.", {
				completed: error.completed,
				total: error.total,
			}),
			{ id: "list-action-error" },
		);
		return;
	}
	toast.error(LIST_ACTION_ERROR, { id: "list-action-error" });
}

/** Read-only shared mail stays where it is when a bulk action moves or deletes the rest. */
export function reportReadOnlySkipped(skipped: number, nothingAllowed: boolean) {
	if (skipped === 0) return;
	const message = nothingAllowed
		? t("Read-only mail can't be moved or deleted.")
		: `${skipped === 1 ? "1 read-only message was" : `${skipped} read-only messages were`} left as it was.`;
	toast(message, { id: "list-action-read-only" });
}

/** Read-only shared mail is never answered or forwarded: its mailbox cannot send for this user. */
export function reportReadOnlyAnswer() {
	toast(t("Read-only mail can't be answered or forwarded."), { id: "list-action-read-only" });
}

/** "Select all in folder" stopped at its cap instead of resolving the whole folder. */
export function reportSelectAllTruncated(max: number) {
	toast(t("Only the first {max} were selected. Narrow your search to select the rest.", { max }), {
		id: "list-action-select-all-truncated",
	});
}
