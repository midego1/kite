import { deleteSubscription, editSubscription, setSubscriptionStatus, trackSubscription } from "@/lib/finance/actions";
import { answerSubscription } from "@/lib/finance/answer";
import { previewTrackSubscription, trackSubscriptionTool } from "@/lib/finance/chat-track";
import { detectSubscriptionStep, wantsModelStep } from "@/lib/finance/detect";
import { deleteDocument, recordDocument } from "@/lib/finance/document-actions";
import { removePaymentAction, updatePaymentAction } from "@/lib/finance/payment-actions";
import { resumePaymentScans, scanPayments } from "@/lib/finance/payment-scan";
import { recordPaymentStep } from "@/lib/finance/payment-step";
import { resolveFinanceRefs } from "@/lib/finance/refs";
import { remindRenewals } from "@/lib/finance/reminders";
import { searchSubscriptions } from "@/lib/finance/search";
import { listSubscriptionsTool } from "@/lib/finance/tools";
import type { CapabilityHandler } from "../module-types";

export const financeHandlers: Record<string, CapabilityHandler> = {
	detect: detectSubscriptionStep,
	recordPayment: recordPaymentStep,
	wantsModel: wantsModelStep,
	answerSubscription,
	trackSubscription,
	editSubscription,
	setSubscriptionStatus,
	deleteSubscription,
	recordDocument,
	deleteDocument,
	updatePayment: updatePaymentAction,
	removePayment: removePaymentAction,
	scanPayments,
	resumePaymentScans,
	resolveRefs: resolveFinanceRefs,
	search: searchSubscriptions,
	list_subscriptions: listSubscriptionsTool,
	track_subscription: trackSubscriptionTool,
	previewTrackSubscription,
	remindRenewals,
};
