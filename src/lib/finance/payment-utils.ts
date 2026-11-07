import type { Analysis } from "./detect-utils";
import { bodySaysOwed, isDocumentAttachment, subjectSaysOwed } from "./document-utils";
import { SUBJECT_KEYWORD } from "./keywords-utils";
import {
	BRACKETED_NUMBER,
	DOCUMENT_NUMBER,
	FREE_MAIL_DOMAINS,
	MARKETING_PHRASE,
	MONEY_LABEL,
	PERCENT_OFF,
	REPLY_OR_FORWARD,
} from "./payment-keywords-utils";
import { registrableDomain, senderAddress } from "./vendor-utils";
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
	/** The receipt, invoice or order number, normalised; one row per vendor, type and number. */
	docRef: string | null;
	/** The `Message-ID`, normalised; one row per copy of a message delivered to several mailboxes. */
	mailRef: string | null;
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
	const { subject, text } = textOf(input);
	// A reply or forward is a copy of a document that is (or will be) recorded from the original.
	if (REPLY_OR_FORWARD.test(subject)) return null;
	const document = documentOf(analysis, deterministic);
	if (!document) return null;
	// A person at a free mail provider: only a mail carrying the document itself counts, keyed by the address.
	const person = freeMailSender(input.message.from);
	if (person && !input.attachments.some(isDocumentAttachment)) return null;
	const confident = document.confident;
	const marketing = looksLikeMarketing(text);
	if (marketing && (!confident || input.facts.list)) return null;
	if (!confident && !(MONEY_LABEL.test(text) && analysis.signals.has("billing_sender"))) return null;
	if (paymentScore(analysis, input, confident) < PAYMENT_WEIGHT) return null;
	// A type the model filled may still be "paid" for a mail that says it was not.
	const docType =
		document.docType === "payment" && (subjectSaysOwed(subject) || bodySaysOwed(input.message.textExcerpt ?? ""))
			? "invoice"
			: document.docType;
	return {
		vendor: analysis.vendor,
		vendorKey: person ? `mail:${person}`.slice(0, 120) : analysis.vendorKey,
		docType,
		status: initialStatus(docType),
		amountMinor: analysis.amount.minor,
		currency: analysis.amount.currency,
		documentOn: document.documentOn,
		attachmentId: document.attachmentId,
		modelFields: analysis.modelFields.filter((field) => ["vendor", "amount", "currency", "docType"].includes(field)),
		docRef: rowReference(docType, documentReference(subject, text), analysis.amount),
		mailRef: messageReference(input.headers.messageId),
	};
}

const MAX_REF = 60;

/** The document's number from the subject's bracketed reference or a numbered document word, upper case.
 * @public Exercised by the bundled unit tests.
 */
export function documentReference(subject: string, text: string): string | null {
	const bracketed = BRACKETED_NUMBER.exec(subject)?.[0];
	const numbered = bracketed ?? DOCUMENT_NUMBER.exec(subject)?.[0] ?? DOCUMENT_NUMBER.exec(text)?.[0];
	const code = numbered ? /[A-Z0-9][A-Z0-9-]{3,40}(?=\]?$)/iu.exec(numbered.trim())?.[0] : undefined;
	return code ? code.toUpperCase().slice(0, MAX_REF) : null;
}

/**
 * What a row's number dedupes on. An invoice collapses on its number alone, so a reminder is not a second invoice. A
 * payment, refund or credit note often names the order or invoice it belongs to, and one order can have several
 * (partial refunds, instalments), so its amount and currency are part of it: `A12345:1500EUR`.
 * @public Exercised by the bundled unit tests.
 */
export function rowReference(
	docType: PaymentDocType,
	reference: string | null,
	amount: { minor: number; currency: string },
): string | null {
	if (!reference) return null;
	return docType === "invoice" ? reference : `${reference}:${amount.minor}${amount.currency}`;
}

/** The document number a row names, without the amount a payment's reference carries. */
export const referenceNumber = (docRef: string | null | undefined): string | null => docRef?.split(":")[0] || null;

/** The `Message-ID` without angle brackets, lower case; null when there is none.
 * @public Exercised by the bundled unit tests.
 */
export function messageReference(messageId: string | null | undefined): string | null {
	const value = (messageId ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
	return value && value.length <= 300 && value.includes("@") ? value : null;
}

/** A sender at a mail provider anyone can sign up to, where the domain names no vendor. */
function freeMailSender(from: string): string | null {
	const address = senderAddress(from);
	const at = address.lastIndexOf("@");
	return at > 0 && FREE_MAIL_DOMAINS.has(registrableDomain(address.slice(at + 1))) ? address : null;
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
