"use client";

import toast from "react-hot-toast";

const LIST_ACTION_ERROR = "Could not update the messages. Please try again.";

/** Tells the user a list or row action failed; one toast id, so repeated failures do not stack. */
export function reportListActionError(error: unknown) {
	console.error(error);
	toast.error(LIST_ACTION_ERROR, { id: "list-action-error" });
}
