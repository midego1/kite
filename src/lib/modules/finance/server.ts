import { deleteSubscription, editSubscription, setSubscriptionStatus, trackSubscription } from "@/lib/finance/actions";
import { answerSubscription } from "@/lib/finance/answer";
import { detectSubscriptionStep, wantsModelStep } from "@/lib/finance/detect";
import { deleteDocument, recordDocument } from "@/lib/finance/document-actions";
import { resolveFinanceRefs } from "@/lib/finance/refs";
import { remindRenewals } from "@/lib/finance/reminders";
import { searchSubscriptions } from "@/lib/finance/search";
import { listSubscriptionsTool } from "@/lib/finance/tools";
import type { CapabilityHandler } from "../module-types";

export const financeHandlers: Record<string, CapabilityHandler> = {
	detect: detectSubscriptionStep,
	wantsModel: wantsModelStep,
	answerSubscription,
	trackSubscription,
	editSubscription,
	setSubscriptionStatus,
	deleteSubscription,
	recordDocument,
	deleteDocument,
	resolveRefs: resolveFinanceRefs,
	search: searchSubscriptions,
	list_subscriptions: listSubscriptionsTool,
	remindRenewals,
};
