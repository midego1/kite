import toast from "react-hot-toast";
import type { BulkMessageResponse } from "@/app/api/messages/bulk/types";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { describePhishingReports, phishingConfirmCopy } from "./phishing-report-utils";

export function confirmReportPhishing(count: number) {
	return requestConfirmation(phishingConfirmCopy(count));
}

/** Tells the user what a "phishing" bulk action did; there is no Undo, since the sender is blocked. */
export function announcePhishingReports(response: BulkMessageResponse | null) {
	const text = describePhishingReports(response?.reports ?? []);
	if (text) toast.success(text);
}
