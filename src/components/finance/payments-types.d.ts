import type { PaymentCategory } from "@/lib/finance/category-utils";
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
	/** A payment row's category; null for a subscription document and for a row without one. */
	category: PaymentCategory | null;
	subscriptionId: string | null;
	messageId: string | null;
	message: ResolvedRecordRef | null;
	/** The sender's domain (or a free-mail address) of a payment row; null for a subscription document. */
	sender: string | null;
	/** Fields the assistant read, shown as such. */
	modelFields: string[];
	/** How a payment row was found; null for a subscription document. */
	origin: "auto" | "scan" | null;
	/** Whether "Keep receipts" already filed a copy of this row's mail into Drive. */
	hasReceipts: boolean;
};

export type ScanState = {
	status: "running" | "done" | "failed";
	scanned: number;
	recorded: number;
	/** Messages that could not be read and were passed over. */
	skipped: number;
	startedAt: string;
	finishedAt: string | null;
};

/**
 * Mail "Scan last 90 days" never records, and why, so the Payments tab can say why a count seems low without
 * promising a fix that would not help (`no_authentication`, `different_reviewer`).
 */
export type ScanCoverageGap =
	| { reason: "automatic_reading_off"; messages: number }
	| { reason: "no_authentication"; messages: number }
	| { reason: "different_reviewer"; messages: number };

export type PaymentList = {
	payments: PaymentItem[];
	/** Month totals over every row, also those past the list's cap. */
	months: MonthCurrencyTotal[];
	/** The list holds only the newest rows. */
	truncated?: boolean;
	/** Every payment row and subscription document, whatever the list holds. */
	total?: number;
	scan: ScanState | null;
	scanCoverage: ScanCoverageGap[];
	migrationPending?: true;
};

/** `category` is `""` for all, `none` for rows without one, or a category. */
export type PaymentFilters = { vendor: string; month: string; status: PaymentListStatus | ""; category: string };

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
	/** `""` for no category. */
	category: PaymentCategory | "";
};
