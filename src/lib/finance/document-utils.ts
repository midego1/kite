import {
	acceptDay,
	addDays,
	addMonths,
	daysBetween,
	formatDay,
	inWindow,
	isRealDate,
	scanDates,
	type DateContext,
	type DayWindow,
	type FoundDate,
} from "./date-utils";
import {
	ATTACHMENT_WORDS,
	CREDIT_PHRASES,
	DOCUMENT_DATE_LABEL,
	INVOICE_PHRASES,
	PAYMENT_PHRASES,
	PERIOD_LABEL,
	REFUND_PHRASES,
	phraseRegex,
} from "./keywords-utils";
import type { DocType } from "./types";

export type StepAttachment = { id: string; contentType: string; filename: string | null; size: number };

export type DocumentInfo = {
	docType: DocType;
	documentOn: string;
	periodStartOn: string | null;
	periodEndOn: string | null;
	attachmentId: string | null;
};

export type ClassifiedDocument = DocumentInfo & {
	/** From the subject, an attachment name or the payment-failed phrases; a body-only match is weak. */
	confident: boolean;
};

/** Refunds and credit notes quote the payment they return, and receipts quote the invoice, so the order matters. */
const PRECEDENCE: readonly { docType: Exclude<DocType, "failed_payment">; pattern: RegExp }[] = [
	{ docType: "refund", pattern: phraseRegex(REFUND_PHRASES) },
	{ docType: "credit", pattern: phraseRegex(CREDIT_PHRASES) },
	{ docType: "payment", pattern: phraseRegex(PAYMENT_PHRASES) },
	{ docType: "invoice", pattern: phraseRegex(INVOICE_PHRASES) },
];

const RANK: Record<string, number> = { refund: 0, credit: 1, payment: 2, invoice: 3 };

/** The document type a text names, by precedence, or null.
 * @public Exercised by the bundled unit tests.
 */
export function docTypeOfText(text: string): Exclude<DocType, "failed_payment"> | null {
	return PRECEDENCE.find((entry) => entry.pattern.test(text))?.docType ?? null;
}

/** The document type the attachment names suggest, by the same precedence.
 * @public Exercised by the bundled unit tests.
 */
export function docTypeOfFilenames(attachments: readonly StepAttachment[]): Exclude<DocType, "failed_payment"> | null {
	let best: Exclude<DocType, "failed_payment"> | null = null;
	for (const attachment of attachments) {
		const name = (attachment.filename ?? "").toLowerCase();
		for (const { word, docType } of ATTACHMENT_WORDS)
			if (name.includes(word) && (best === null || RANK[docType] < RANK[best])) best = docType;
	}
	return best;
}

function isPdf(attachment: StepAttachment): boolean {
	return (
		attachment.contentType.toLowerCase().startsWith("application/pdf") ||
		(attachment.filename ?? "").toLowerCase().endsWith(".pdf")
	);
}

function isImage(attachment: StepAttachment): boolean {
	return attachment.contentType.toLowerCase().startsWith("image/");
}

function namesDocument(attachment: StepAttachment): boolean {
	const name = (attachment.filename ?? "").toLowerCase();
	return ATTACHMENT_WORDS.some(({ word }) => name.includes(word));
}

/** A PDF or image whose name says invoice, receipt, credit or refund (the `invoice_attachment` signal). */
export function isDocumentAttachment(attachment: StepAttachment): boolean {
	return (isPdf(attachment) || isImage(attachment)) && namesDocument(attachment);
}

/** The first keyword PDF, then the first keyword image, then the only PDF, else none.
 * @public Exercised by the bundled unit tests.
 */
export function documentAttachment(attachments: readonly StepAttachment[]): string | null {
	const named = attachments.filter(namesDocument);
	const pdf = named.find(isPdf) ?? named.find(isImage);
	if (pdf) return pdf.id;
	const pdfs = attachments.filter(isPdf);
	return pdfs.length === 1 ? pdfs[0].id : null;
}

/** The stated document date within 400 days before to 1 day after the message, else the message date.
 * @public Exercised by the bundled unit tests.
 */
export function documentDate(text: string, ctx: DateContext): string {
	const window: DayWindow = { from: addDays(ctx.messageDay, -400), to: addDays(ctx.messageDay, 1) };
	for (const match of text.matchAll(new RegExp(DOCUMENT_DATE_LABEL.source, "giu"))) {
		const start = match.index + match[0].length;
		const [first] = scanDates(text.slice(start, start + 40), ctx.monthFirst);
		if (!first) continue;
		const day = acceptDay(first, ctx, window);
		if (day) return day;
	}
	return ctx.messageDay;
}

const RANGE_JOINER = /^\s*(?:-|–|—|to|through|until|tot|bis|au|al|a|hasta)\s*$/iu;

function isBefore(a: Pick<FoundDate, "month" | "day">, b: Pick<FoundDate, "month" | "day">): boolean {
	return a.month < b.month || (a.month === b.month && a.day < b.day);
}

/** The year-less side of a range takes the other side's year, moved so the start never follows the end. */
function rangeDays(start: FoundDate, end: FoundDate): [string, string] | null {
	if (start.year === null && end.year === null) return null;
	const startYear = start.year ?? end.year! - (isBefore(end, start) ? 1 : 0);
	const endYear = end.year ?? start.year! + (isBefore(end, start) ? 1 : 0);
	if (!isRealDate(startYear, start.month, start.day) || !isRealDate(endYear, end.month, end.day)) return null;
	return [formatDay(startYear, start.month, start.day), formatDay(endYear, end.month, end.day)];
}

/** An ambiguous endpoint is settled when the other one is an unambiguous numeric date read the same way. */
function settledBy(endpoint: FoundDate, other: FoundDate): boolean {
	return !endpoint.ambiguous || (!other.ambiguous && other.order === endpoint.order);
}

function farAmbiguous(endpoint: FoundDate, day: string, other: FoundDate, ctx: DateContext): boolean {
	return !settledBy(endpoint, other) && Math.abs(daysBetween(ctx.messageDay, day)) > 31;
}

/** The stated period a document covers; both days or neither, never inferred from the cycle.
 * @public Exercised by the bundled unit tests.
 */
export function documentPeriod(text: string, ctx: DateContext): { start: string; end: string } | null {
	const window: DayWindow = { from: addDays(ctx.messageDay, -400), to: addMonths(ctx.messageDay, 24) };
	for (const match of text.matchAll(new RegExp(PERIOD_LABEL.source, "giu"))) {
		const start = match.index + match[0].length;
		const segment = text.slice(start, start + 80);
		const dates = scanDates(segment, ctx.monthFirst);
		if (dates.length < 2) continue;
		if (!RANGE_JOINER.test(segment.slice(dates[0].end, dates[1].index))) continue;
		const range = rangeDays(dates[0], dates[1]);
		if (!range) continue;
		const [from, to] = range;
		if (farAmbiguous(dates[0], from, dates[1], ctx) || farAmbiguous(dates[1], to, dates[0], ctx)) continue;
		const length = daysBetween(from, to);
		if (length < 0 || length > 366 || !inWindow(from, window) || !inWindow(to, window)) continue;
		return { start: from, end: to };
	}
	return null;
}

export type ClassifyInput = {
	subject: string;
	excerpt: string;
	attachments: readonly StepAttachment[];
	paymentFailed: boolean;
	hasAmount: boolean;
	dates: DateContext;
};

function chooseType(input: ClassifyInput): { docType: DocType; confident: boolean } | null {
	if (input.paymentFailed) return { docType: "failed_payment", confident: true };
	const fromSubject = docTypeOfText(input.subject);
	if (fromSubject) return { docType: fromSubject, confident: true };
	const fromFiles = docTypeOfFilenames(input.attachments);
	if (fromFiles) return { docType: fromFiles, confident: true };
	const fromBody = docTypeOfText(input.excerpt);
	return fromBody ? { docType: fromBody, confident: false } : null;
}

/**
 * The money document a message is: payment-failed phrases first, then the subject, then attachment
 * names, then the body (weak). Null for a notice, or for a document type without an amount (only a
 * failed payment may have none).
 */
export function classifyDocument(input: ClassifyInput): ClassifiedDocument | null {
	const chosen = chooseType(input);
	if (!chosen) return null;
	if (chosen.docType !== "failed_payment" && !input.hasAmount) return null;
	return { ...chosen, ...documentDetails(input) };
}

export type DocumentDetails = Omit<DocumentInfo, "docType">;

/** The document date, covered period and document attachment of a message, whatever its document type. */
export function documentDetails(
	input: Pick<ClassifyInput, "subject" | "excerpt" | "attachments" | "dates">,
): DocumentDetails {
	const text = `${input.subject}\n${input.excerpt}`;
	const period = documentPeriod(text, input.dates);
	return {
		documentOn: documentDate(text, input.dates),
		periodStartOn: period?.start ?? null,
		periodEndOn: period?.end ?? null,
		attachmentId: documentAttachment(input.attachments),
	};
}
