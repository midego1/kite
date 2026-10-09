"use client";

import toast from "react-hot-toast";

const UNDO_TOAST_DURATION_MS = 8000;

/** A toast with an Undo button; failures of the undo itself are reported in a follow-up toast. */
export function showUndoToast(message: string, onUndo: () => Promise<void>) {
	toast(
		(current) => (
			<span className="flex items-center gap-4 text-sm">
				<span>{message}</span>
				<button
					type="button"
					className="rounded-md px-2 py-1 font-semibold text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					onClick={() => {
						toast.dismiss(current.id);
						void onUndo().catch(() => toast.error("Could not undo. Please try again."));
					}}
				>
					Undo
				</button>
			</span>
		),
		{ duration: UNDO_TOAST_DURATION_MS, ariaProps: { role: "status", "aria-live": "polite" } },
	);
}
