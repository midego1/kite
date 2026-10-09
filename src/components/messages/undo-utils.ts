import type { BulkMessageResponse, MessageRestoreState } from "@/app/api/messages/bulk/types";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";

export function describeUndoableMove(action: string, count: number): string | null {
	const subject = count === 1 ? "Message" : `${count} messages`;
	if (action === "trash") return `${subject} moved to Trash`;
	if (action === "archive") return `${subject} archived`;
	return null;
}

export async function restoreMessages(states: MessageRestoreState[]): Promise<void> {
	const response = await authFetch("/api/messages/bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "restore", restore: states }),
	});
	if (!response.ok) throw new Error("Unable to undo");
	window.dispatchEvent(new Event("kite:messages-changed"));
}

/** Offers to undo an archive or trash the bulk endpoint reported previous states for. */
export function offerUndoForMove(action: string, response: BulkMessageResponse | null) {
	const states = response?.undo ?? [];
	const message = describeUndoableMove(action, states.length);
	if (!message || states.length === 0) return;
	showUndoToast(message, () => restoreMessages(states));
}
