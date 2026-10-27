import type { BulkMessageResponse, MessageRestoreState } from "@/app/api/messages/bulk/types";
import toast from "react-hot-toast";
import { showUndoToast } from "@/components/ui/undo-toast";
import { authFetch } from "@/lib/auth/client";

export function describeUndoableMove(action: string, count: number): string | null {
	const subject = count === 1 ? "Message" : `${count} messages`;
	if (action === "trash") return `${subject} moved to Trash`;
	if (action === "archive") return `${subject} archived`;
	if (action === "spam") return count === 1 ? "Reported as spam" : `${count} messages reported as spam`;
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
	offerUndo(message, response);
}

const TRAINING_KEPT_NOTICE =
	"Moved back. What the filter learned can't be undone until the database update is applied.";

/** An Undo toast for `states`; a report whose training could not be recorded says so once it is undone. */
export function offerUndo(message: string, response: BulkMessageResponse | null) {
	const states = response?.undo ?? [];
	showUndoToast(message, async () => {
		await restoreMessages(states);
		if (response?.trainingUndoUnavailable) toast(TRAINING_KEPT_NOTICE);
	});
}
