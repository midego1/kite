import type { ResolvedRecordRef } from "@/lib/modules/record-ref-types";
import type { CurrencyTotal } from "@/lib/finance/totals-utils";
import type { Cycle, DocType, SubscriptionStatus } from "@/lib/finance/types";

export type Money = { minor: number; currency: string };

/** A subscription as `GET /api/finance/subscriptions` lists it. */
export type SubscriptionItem = {
	id: string;
	vendor: string;
	plan: string | null;
	amount: Money | null;
	cycle: Cycle | null;
	status: SubscriptionStatus;
	nextRenewalOn: string | null;
	renewalEstimated: boolean;
	trialEndsOn: string | null;
	urgent: boolean;
	reminderDays: number;
	calendarReminder: boolean;
	cancelUrl: string | null;
	previousAmountMinor: number | null;
	priceChangedAt: string | null;
	lastMessageId: string | null;
	sourceMessageId: string | null;
	mailboxId: string | null;
};

export type SubscriptionList = {
	subscriptions: SubscriptionItem[];
	totals: CurrencyTotal[];
	migrationPending?: true;
};

/** A ledger row as the detail view shows it, with its source message resolved for the viewer. */
export type DocumentItem = {
	id: string;
	docType: DocType;
	amount: Money | null;
	documentOn: string | null;
	periodStartOn: string | null;
	periodEndOn: string | null;
	messageId: string | null;
	attachmentId: string | null;
	paired: boolean;
	message: ResolvedRecordRef | null;
};

export type SubscriptionDetail = {
	subscription: SubscriptionItem;
	paidLast12Months: { currency: string; minor: number }[];
	documents: DocumentItem[];
};

/** The pre-0063 detail answer: HTTP 200 without a subscription. */
export type SubscriptionDetailPending = { migrationPending: true };

export type DrawerState =
	| { kind: "closed" }
	| { kind: "loading" }
	| { kind: "missing" }
	| { kind: "migration-pending" }
	| { kind: "ready"; detail: SubscriptionDetail };

export type StatusFilter = "current" | "ended" | "all";

export type AttentionEntry = { item: SubscriptionItem; reason: string };

export type SubscriptionGroups = {
	attention: AttentionEntry[];
	upcoming: SubscriptionItem[];
	noDate: SubscriptionItem[];
	ended: SubscriptionItem[];
};
