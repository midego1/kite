import type { ResolvedRecordRef } from "@/lib/modules/record-ref-types";

export type PaymentDocType = "invoice" | "payment" | "credit" | "refund" | "failed_payment";

export type PaymentListStatus = "open" | "paid" | "refunded" | "credited" | "failed";

/** One row of `GET /api/finance/payments`. */
export type PaymentItem = {
	id: string;
	/** `payment` for a row found in mail, `subscription` for a tracked subscription's document. */
	source: "payment" | "subscription";
	docType: PaymentDocType;
	/** What the row shows: a paired invoice is paid. */
	status: PaymentListStatus;
	/** The stored status, which a correction starts from. */
	storedStatus: PaymentListStatus;
	/** Counts once through the payment or refund it pairs with. */
	paired: boolean;
	vendor: string;
	amount: { minor: number; currency: string } | null;
	documentOn: string;
	subscriptionId: string | null;
	messageId: string | null;
	message: ResolvedRecordRef | null;
	/** Fields the assistant read, shown as such. */
	modelFields: string[];
	/** How a payment row was found; null for a subscription document. */
	origin: "auto" | "scan" | null;
};

export type ScanState = {
	status: "running" | "done" | "failed";
	scanned: number;
	recorded: number;
	startedAt: string;
	finishedAt: string | null;
};

export type PaymentList = {
	payments: PaymentItem[];
	/** Month totals over every row, also those past the list's cap. */
	months: MonthCurrencyTotal[];
	/** The list holds only the newest rows. */
	truncated?: boolean;
	scan: ScanState | null;
	migrationPending?: true;
};

export type PaymentFilters = { vendor: string; month: string; status: PaymentListStatus | "" };

export type MonthCurrencyTotal = {
	month: string;
	currency: string;
	paidMinor: number;
	refundedMinor: number;
	openMinor: number;
};

/** The correction dialog's fields, as text the inputs hold. */
export type PaymentForm = {
	vendor: string;
	amount: string;
	currency: string;
	documentOn: string;
	docType: "invoice" | "payment" | "credit" | "refund";
	status: "open" | "paid";
};
