import type { BulkMessagePayload, BulkMessageResponse } from "@/app/api/messages/bulk/types";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { authFetch } from "@/lib/auth/client";
import { draftDeletionConfirmation, draftsNeedingConfirmation } from "./bulk-request-utils";

/**
 * Posts a bulk message action. When a Delete or Trash selection holds the user's own drafts, the server changes
 * nothing and says how many; this asks first, because a draft is deleted for good rather than moved to Trash,
 * and sends the request again with `deleteDrafts`. Resolves to null when the user cancels.
 */
export async function postBulkMessageAction(payload: BulkMessagePayload): Promise<Response | null> {
	const send = (deleteDrafts?: boolean) =>
		authFetch("/api/messages/bulk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(deleteDrafts ? { ...payload, deleteDrafts } : payload),
		});
	const response = await send();
	if (response.status !== 409) return response;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as BulkMessageResponse | null;
	const drafts = draftsNeedingConfirmation(response.status, body);
	if (drafts === null) return response;
	if (!(await requestConfirmation(draftDeletionConfirmation(drafts)))) return null;
	return send(true);
}
