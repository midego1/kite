import type { Analysis } from "./detect-utils";
import { isDocumentAttachment } from "./document-utils";
import { SUBJECT_KEYWORD } from "./keywords-utils";
import {
	BRACKETED_NUMBER,
	DOCUMENT_NUMBER,
	MARKETING_PHRASE,
	MONEY_LABEL,
	PERCENT_OFF,
} from "./payment-keywords-utils";
import type { DetectStepInput, ModelField } from "./types";

/** The document types a payment row can have: a failed charge is not a payment. */
export type PaymentDocType = "invoice" | "payment" | "credit" | "refund";

export type PaymentStatus = "open" | "paid" | "refunded" | "credited";

/** What one message records in the Payments tab (spec §25.1). */
export type PaymentFinding = {
	vendor: string;
	vendorKey: string;
	docType: PaymentDocType;
	status: PaymentStatus;
	amountMinor: number;
	currency: string;
	documentOn: string;
	attachmentId: string | null;
	modelFields: ModelField[];
};

/** At least this much evidence records a payment.
 * @public Exercised by the bundled unit tests.
 */
export const PAYMENT_WEIGHT = 3;

const STATUS: Record<PaymentDocType, PaymentStatus> = {
	invoice: "open",
	payment: "paid",
	refund: "refunded",
	credit: "credited",
};

/** The status a document type starts with: an invoice is open until paid, the rest are settled. */
export function initialStatus(docType: PaymentDocType): PaymentStatus {
	return STATUS[docType];
}

const MAX_TEXT = 8_192 + 300;

function textOf(input: DetectStepInput): { subject: string; text: string } {
	const subject = (input.message.subject ?? "").slice(0, 300);
	return { subject, text: `${subject}\n${input.message.textExcerpt ?? ""}`.slice(0, MAX_TEXT) };
}

/** Sales copy: a marketing phrase or a percentage discount anywhere in the subject or the excerpt. */
function looksLikeMarketing(text: string): boolean {
	return MARKETING_PHRASE.test(text) || PERCENT_OFF.test(text);
}

/** Phishing, spam, a muted sender, a spoofed sender or a message the model flagged never records. */
export function paymentBlocked(input: DetectStepInput): boolean {
	const { facts } = input;
	if (facts.phishing.length > 0 || facts.spam || facts.muted === true || !facts.authPassed) return true;
	const suspicious = (input.model as { suspicious?: { flagged?: unknown } } | null)?.suspicious;
	return suspicious?.flagged === true;
}

/** The evidence a message is a money document, by the weights of §25.1. @public Exercised by the bundled unit tests. */
export function paymentScore(analysis: Analysis, input: DetectStepInput, confident: boolean): number {
	const { subject, text } = textOf(input);
	const checks: [number, boolean][] = [
		[2, confident],
		[1, input.attachments.some(isDocumentAttachment)],
		[1, analysis.signals.has("billing_sender")],
		[1, MONEY_LABEL.test(text)],
		[1, DOCUMENT_NUMBER.test(text) || BRACKETED_NUMBER.test(subject)],
	];
	return checks.reduce((total, [weight, on]) => (on ? total + weight : total), 0);
}

/**
 * The document the deterministic analysis classified, or the type a validated model filled. A model type needs the
 * same receipt evidence the hint asks for (a billing subject or a document attachment), so a personal message the
 * model calls a receipt records nothing.
 */
function documentOf(analysis: Analysis, deterministic: Analysis) {
	const document = analysis.document;
	if (!document || document.docType === "failed_payment") return null;
	const fromModel = analysis.modelFields.includes("docType") || analysis.modelFields.includes("amount");
	if (fromModel && !deterministic.signals.has("subject_keyword") && !deterministic.signals.has("invoice_attachment"))
		return null;
	return { ...document, docType: document.docType as PaymentDocType };
}

/**
 * Whether a message is a payment document to record, and what it records (spec §25.1). `analysis` is the merged
 * analysis (the detector plus a validated model extension), `deterministic` the detector alone. Pure: the caller
 * checks the owner's tracked subscriptions and the ledger.
 */
export function detectPayment(
	analysis: Analysis,
	deterministic: Analysis,
	input: DetectStepInput,
): PaymentFinding | null {
	if (paymentBlocked(input) || analysis.paymentFailed || !analysis.amount) return null;
	const document = documentOf(analysis, deterministic);
	if (!document) return null;
	const { text } = textOf(input);
	const confident = document.confident;
	const marketing = looksLikeMarketing(text);
	if (marketing && (!confident || input.facts.list)) return null;
	if (!confident && !(MONEY_LABEL.test(text) && analysis.signals.has("billing_sender"))) return null;
	if (paymentScore(analysis, input, confident) < PAYMENT_WEIGHT) return null;
	return {
		vendor: analysis.vendor,
		vendorKey: analysis.vendorKey,
		docType: document.docType,
		status: initialStatus(document.docType),
		amountMinor: analysis.amount.minor,
		currency: analysis.amount.currency,
		documentOn: document.documentOn,
		attachmentId: document.attachmentId,
		modelFields: analysis.modelFields.filter((field) => ["vendor", "amount", "currency", "docType"].includes(field)),
	};
}

/** A light message from a backfill page, before its body is read. */
export type LightMessage = {
	from: string;
	subject: string | null;
	attachments: { filename: string | null; contentType: string }[];
};

const BILLING_SENDER = /^(?:billing|invoices?|receipts?|payments?|accounts?)(?:[-_.+].*)?@/i;

/**
 * The cheap first pass of the scan (spec §25.5): a document keyword in the subject, a billing sender or a document
 * attachment. Only messages that pass get their body read, so most mail costs one indexed row read.
 */
export function worthScanning(message: LightMessage): boolean {
	const address = (/<([^<>]+)>/.exec(message.from)?.[1] ?? message.from).trim();
	if (SUBJECT_KEYWORD.test((message.subject ?? "").slice(0, 300))) return true;
	if (BILLING_SENDER.test(address)) return true;
	return message.attachments.some((attachment) =>
		isDocumentAttachment({ id: "", size: 0, contentType: attachment.contentType, filename: attachment.filename }),
	);
}
