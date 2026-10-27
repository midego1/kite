import toast from "react-hot-toast";
import type { BulkMessageResponse } from "@/app/api/messages/bulk/types";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { offerUndo } from "./undo-utils";
import { describePhishingReports, phishingConfirmCopy } from "./phishing-report-utils";

export function confirmReportPhishing(count: number) {
	return requestConfirmation(phishingConfirmCopy(count));
}

/** Tells the user what a "phishing" bulk action did, with an Undo that also lifts the block it placed. */
export function announcePhishingReports(response: BulkMessageResponse | null) {
	const text = describePhishingReports(response?.reports ?? []);
	if (!text) return;
	if (response?.undo?.length) offerUndo(text, response);
	else toast.success(text);
}
