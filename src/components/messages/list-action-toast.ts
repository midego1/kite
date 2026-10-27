"use client";

import toast from "react-hot-toast";

const LIST_ACTION_ERROR = "Could not update the messages. Please try again.";

/** Tells the user a list or row action failed; one toast id, so repeated failures do not stack. */
export function reportListActionError(error: unknown) {
	console.error(error);
	toast.error(LIST_ACTION_ERROR, { id: "list-action-error" });
}

/** Read-only shared mail stays where it is when a bulk action moves or deletes the rest. */
export function reportReadOnlySkipped(skipped: number, nothingAllowed: boolean) {
	if (skipped === 0) return;
	const message = nothingAllowed
		? "Read-only mail can't be moved or deleted."
		: `${skipped === 1 ? "1 read-only message was" : `${skipped} read-only messages were`} left as it was.`;
	toast(message, { id: "list-action-read-only" });
}
