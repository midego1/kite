import { deleteSubscription, editSubscription, setSubscriptionStatus, trackSubscription } from "@/lib/finance/actions";
import { answerSubscription } from "@/lib/finance/answer";
import { detectSubscriptionStep } from "@/lib/finance/detect";
import { deleteDocument, recordDocument } from "@/lib/finance/document-actions";
import { resolveFinanceRefs } from "@/lib/finance/refs";
import { remindRenewals } from "@/lib/finance/reminders";
import type { CapabilityHandler } from "../module-types";

export const financeHandlers: Record<string, CapabilityHandler> = {
	detect: detectSubscriptionStep,
	answerSubscription,
	trackSubscription,
	editSubscription,
	setSubscriptionStatus,
	deleteSubscription,
	recordDocument,
	deleteDocument,
	resolveRefs: resolveFinanceRefs,
	remindRenewals,
};
