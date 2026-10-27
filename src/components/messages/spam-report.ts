import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { spamConfirmCopy } from "./spam-report-utils";

/** Asks before messages are reported as spam; resolves false on Cancel or Esc. There is no way to skip it. */
export function confirmReportSpam(count: number) {
	return requestConfirmation(spamConfirmCopy(count));
}
