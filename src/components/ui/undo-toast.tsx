"use client";

import toast from "react-hot-toast";
import { TOAST_ACTION_CLASS } from "./toast-styles";

const UNDO_TOAST_DURATION_MS = 8000;

/** A toast with one action button; failures of the action itself are reported in a follow-up toast. */
function showActionToast(message: string, actionLabel: string, onAction: () => Promise<void>, failureMessage: string) {
	toast(
		(current) => (
			<span className="flex items-center gap-4 text-sm">
				<span>{message}</span>
				<button
					type="button"
					className={TOAST_ACTION_CLASS}
					onClick={() => {
						toast.dismiss(current.id);
						void onAction().catch(() => toast.error(failureMessage));
					}}
				>
					{actionLabel}
				</button>
			</span>
		),
		{ duration: UNDO_TOAST_DURATION_MS, ariaProps: { role: "status", "aria-live": "polite" } },
	);
}

/** A toast with an Undo button; failures of the undo itself are reported in a follow-up toast. */
export function showUndoToast(message: string, onUndo: () => Promise<void>) {
	showActionToast(message, "Undo", onUndo, "Could not undo. Please try again.");
}

/**
 * A toast with a Retry button, for the part of a batched action (Undo included) that a later batch's failure
 * left undone while the batches before it already went through.
 */
export function showRetryToast(
	message: string,
	retryLabel: string,
	onRetry: () => Promise<void>,
	failureMessage: string,
) {
	showActionToast(message, retryLabel, onRetry, failureMessage);
}
