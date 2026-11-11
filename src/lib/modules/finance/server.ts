import { deleteSubscription, editSubscription, setSubscriptionStatus, trackSubscription } from "@/lib/finance/actions";
import { answerSubscription } from "@/lib/finance/answer";
import { previewTrackSubscription, trackSubscriptionTool } from "@/lib/finance/chat-track";
import { detectSubscriptionStep, wantsModelStep } from "@/lib/finance/detect";
import { deleteDocument, recordDocument } from "@/lib/finance/document-actions";
import { removePaymentAction, updatePaymentAction } from "@/lib/finance/payment-actions";
import { resumePaymentScans, scanPayments } from "@/lib/finance/payment-scan";
import { recordPaymentStep } from "@/lib/finance/payment-step";
import { backfillReceipts, resumeReceiptBackfills } from "@/lib/finance/receipt-backfill";
import { sweepReceipts } from "@/lib/finance/receipts";
import { listPaymentsTool } from "@/lib/finance/payment-tools";
import { searchPayments } from "@/lib/finance/payment-search";
import { resolveFinanceRefs } from "@/lib/finance/refs";
import { remindRenewals } from "@/lib/finance/reminders";
import { searchSubscriptions } from "@/lib/finance/search";
import { listSubscriptionsTool } from "@/lib/finance/tools";
import type { CapabilityHandler, JsonValue } from "../module-types";

const fileReceipts: CapabilityHandler = async (): Promise<JsonValue> => await sweepReceipts();

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
	searchPayments,
	list_subscriptions: listSubscriptionsTool,
	list_payments: listPaymentsTool,
	track_subscription: trackSubscriptionTool,
	previewTrackSubscription,
	remindRenewals,
	fileReceipts,
	backfillReceipts,
	resumeReceiptBackfills,
};
