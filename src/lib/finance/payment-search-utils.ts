import { dateToDay } from "./record-utils";
import { shortDay } from "./text-utils";
import type { PaymentDocType } from "./payment-utils";

const TYPE_TEXT: Record<PaymentDocType, string> = {
	invoice: "Invoice",
	payment: "Payment",
	credit: "Credit note",
	refund: "Refund",
};

type SublabelRow = { docType: PaymentDocType; documentAt: Date; category: string | null };

/** The search row's second line: "Payment · 3 Nov · shopping". */
export function paymentSublabel(row: SublabelRow): string {
	return [TYPE_TEXT[row.docType], shortDay(dateToDay(row.documentAt)!), row.category].filter(Boolean).join(" · ");
}
