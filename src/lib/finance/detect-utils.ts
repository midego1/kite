import { parseAmounts, pickAmount } from "./amount-utils";
import { parseCancelLink, type CancelLink } from "./cancel-link-utils";
import {
	addDays,
	addMonths,
	dateAfterPhrase,
	dayInTimeZone,
	daysBetween,
	receiptWindow,
	type DateContext,
} from "./date-utils";
import {
	classifyDocument,
	documentDetails,
	isDocumentAttachment,
	type ClassifiedDocument,
	type DocumentDetails,
	type DocumentInfo,
} from "./document-utils";
import {
	BILLING_LOCAL,
	CYCLE_PHRASES,
	NO_REPLY_LOCAL,
	PAYMENT_FAILED,
	RENEWAL_PHRASE,
	SUBJECT_KEYWORD,
	TOTAL_PHRASE,
	TRIAL_PHRASE,
} from "./keywords-utils";
import { cleanText, senderLocalPart, senderUsesUsDomain, vendorKey, vendorName } from "./vendor-utils";
import type {
	DetectStepInput,
	Cycle,
	ModelField,
	SubscriptionEvent,
	SubscriptionPayload,
	TrackedMatchRow,
} from "./types";

const MAX_SUBJECT = 300;
const MAX_SIGNALS = 8;
/** A candidate needs at least this much evidence (§5.3).
 * @public Exercised by the bundled unit tests.
 */
export const CANDIDATE_WEIGHT = 4;

const WEIGHTS: Record<string, number> = {
	subject_keyword: 2,
	billing_sender: 1,
	cycle: 3,
	renewal_date: 3,
	trial: 3,
	recurring: 3,
	invoice_attachment: 1,
	model_receipt: 1,
};

/** What the receipt score counts: the signals the hint can see before the model runs (§5.7.2). */
const RECEIPT_WEIGHTS: Record<string, number> = {
	subject_keyword: 2,
	billing_sender: 1,
	amount: 1,
	cycle: 3,
	renewal_date: 3,
	trial: 3,
	invoice_attachment: 1,
};
/** A receipt score at least this high, with a subject keyword or a document attachment, may ask the model.
 * @public Exercised by the bundled unit tests.
 */
export const RECEIPT_MODEL_THRESHOLD = 3;

const SIGNAL_ORDER = [
	"subject_keyword",
	"billing_sender",
	"amount",
	"cycle",
	"renewal_date",
	"trial",
	"recurring",
	"invoice_attachment",
	"model_receipt",
	"model_fields",
	"payment_failed",
	"doc_invoice",
	"doc_payment",
	"doc_credit",
	"doc_refund",
];

const CYCLE_ORDER: readonly Cycle[] = ["quarterly", "monthly", "yearly", "weekly"];

const PLAN_LABEL = /(?<![\p{L}])(?:plan|subscription|abonnement|suscripción|tarif)\s*:\s*([^\n]{1,120})/iu;

/** What the detector reads from one message on its own, before tracked rows and history are consulted. */
export type Analysis = {
	vendor: string;
	vendorFromDomain: boolean;
	vendorKey: string;
	plan: string | null;
	amount: { minor: number; currency: string } | null;
	cycle: Cycle | null;
	renewalOn: string | null;
	trialEndsOn: string | null;
	paymentFailed: boolean;
	document: ClassifiedDocument | null;
	cancelLink: CancelLink | null;
	unverified: boolean;
	signals: Set<string>;
	dates: DateContext;
	/** The document date, period and attachment, for a document type the model names. */
	documentDetails: DocumentDetails;
	/** Fields the validated model extension filled (§5.7.4); empty for the detector alone. */
	modelFields: ModelField[];
	/** Where the model disagreed with a confident amount or currency (§5.7.4, rule 3). */
	modelDisagrees: ("amount" | "currency")[];
};

/** The cycle a phrase names; one on the amount's line wins, else the earliest in the text.
 * @public Exercised by the bundled unit tests.
 */
export function findCycle(text: string, amountLine: string | null): Cycle | null {
	if (amountLine) for (const cycle of CYCLE_ORDER) if (CYCLE_PHRASES[cycle].test(amountLine)) return cycle;
	let best: { cycle: Cycle; index: number } | null = null;
	for (const cycle of CYCLE_ORDER) {
		const index = text.search(CYCLE_PHRASES[cycle]);
		if (index >= 0 && (!best || index < best.index)) best = { cycle, index };
	}
	return best?.cycle ?? null;
}

/** The cycle an interval between two charges suggests (§5.3).
 * @public Exercised by the bundled unit tests.
 */
export function cycleFromInterval(days: number): Cycle | null {
	if (days >= 6 && days <= 8) return "weekly";
	if (days >= 25 && days <= 35) return "monthly";
	if (days >= 85 && days <= 95) return "quarterly";
	if (days >= 355 && days <= 375) return "yearly";
	return null;
}

/** One cycle after a day: the estimated next renewal.
 * @public Exercised by the bundled unit tests.
 */
export function nextAfter(day: string, cycle: Cycle): string {
	if (cycle === "weekly") return addDays(day, 7);
	return addMonths(day, cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12);
}

/** The text before the first price: a currency sign, a code before a number or a number before a code. */
function beforePrice(value: string): string {
	return value.split(
		/[$€£¥₹]|\b[A-Z]{3}\s?\d|\d[\d.,]*\s?[A-Z]{3}\b|(?<!\p{L})[Kk][Rr]\.?\s?\d|\d[\d.,]*\s?[Kk][Rr](?!\p{L})/u,
	)[0];
}

function planOf(text: string, vendor: string, amountLine: string | null): string | null {
	const labelled = PLAN_LABEL.exec(text)?.[1];
	if (labelled) return cleanText(beforePrice(labelled).replace(/\s[-–—|]\s.*$|,.*$/u, ""), 80) || null;
	if (!amountLine) return null;
	const at = amountLine.toLowerCase().indexOf(vendor.toLowerCase());
	if (at === -1) return null;
	const between = beforePrice(amountLine.slice(at + vendor.length));
	const plan = cleanText(between.replace(/^[\s:–-]+|[\s:–-]+$/gu, ""), 80);
	return plan.length >= 2 ? plan : null;
}

function senderSignals(input: DetectStepInput, subjectKeyword: boolean): string[] {
	const local = senderLocalPart(input.message.from);
	if (BILLING_LOCAL.test(local) || (subjectKeyword && NO_REPLY_LOCAL.test(local))) return ["billing_sender"];
	return [];
}

function amountOf(text: string) {
	const amounts = parseAmounts(text);
	const preferred = (line: string) => TOTAL_PHRASE.test(line) || CYCLE_ORDER.some((c) => CYCLE_PHRASES[c].test(line));
	return pickAmount(amounts, preferred);
}

function documentSignal(document: ClassifiedDocument | null): string[] {
	return document && document.docType !== "failed_payment" ? [`doc_${document.docType}`] : [];
}

/** Phishing-flagged and spam mail never becomes a card, whatever it says. */
export function skipsMessage(facts: Pick<DetectStepInput["facts"], "phishing" | "spam">): boolean {
	return facts.phishing.length > 0 || facts.spam;
}

/** Reads one message's billing evidence; null when the sender has no domain to key a vendor by. */
export function analyzeMessage(input: DetectStepInput, timeZone: string): Analysis | null {
	const { message } = input;
	const { vendor, fromDomain } = vendorName(message.fromName, message.from);
	const key = vendor ? vendorKey(message.from, vendor) : null;
	if (!key) return null;
	const subject = (message.subject ?? "").slice(0, MAX_SUBJECT);
	const excerpt = message.textExcerpt ?? "";
	const text = `${subject}\n${excerpt}`;
	const amount = amountOf(text);
	const dates: DateContext = {
		messageDay: dayInTimeZone(message.receivedAt, timeZone),
		monthFirst: amount?.currency === "USD" || senderUsesUsDomain(message.from),
	};
	const window = receiptWindow(dates.messageDay);
	const cycle = findCycle(text, amount?.line ?? null);
	const renewalOn = dateAfterPhrase(text, RENEWAL_PHRASE, dates, window);
	const trialEndsOn = dateAfterPhrase(text, TRIAL_PHRASE, dates, window);
	const paymentFailed = PAYMENT_FAILED.test(text);
	const subjectKeyword = SUBJECT_KEYWORD.test(subject);
	const classify = { subject, excerpt, attachments: input.attachments, dates };
	const document = classifyDocument({ ...classify, paymentFailed, hasAmount: amount !== null });
	const found: [string, boolean][] = [
		["amount", amount !== null],
		["cycle", cycle !== null],
		["renewal_date", renewalOn !== null],
		["trial", trialEndsOn !== null],
		["invoice_attachment", input.attachments.some(isDocumentAttachment)],
		["model_receipt", input.model?.category === "receipt"],
		["payment_failed", paymentFailed],
	];
	const signals = new Set<string>([
		...(subjectKeyword ? ["subject_keyword"] : []),
		...senderSignals(input, subjectKeyword),
		...found.filter(([, on]) => on).map(([signal]) => signal),
		...documentSignal(document),
	]);
	return {
		vendor,
		vendorFromDomain: fromDomain,
		vendorKey: key,
		plan: planOf(text, vendor, amount?.line ?? null),
		amount: amount ? { minor: amount.minor, currency: amount.currency } : null,
		cycle,
		renewalOn,
		trialEndsOn,
		paymentFailed,
		document,
		cancelLink: parseCancelLink(input.headers.listUnsubscribe, input.headers.listUnsubscribePost),
		unverified: !input.facts.authPassed,
		signals,
		dates,
		documentDetails: documentDetails(classify),
		modelFields: [],
		modelDisagrees: [],
	};
}

/** The sum of the weights of the signals found.
 * @public Exercised by the bundled unit tests.
 */
export function signalWeight(signals: Iterable<string>): number {
	let total = 0;
	for (const signal of signals) total += WEIGHTS[signal] ?? 0;
	return total;
}

/** The §5.7.2 receipt score: deterministic signals only, so it can be computed before the model runs.
 * @public Exercised by the bundled unit tests.
 */
export function receiptScore(signals: ReadonlySet<string>): number {
	let total = 0;
	for (const signal of signals) total += RECEIPT_WEIGHTS[signal] ?? 0;
	return total;
}

/** The deterministic receipt evidence that may ask the model, and that a model-assisted candidate needs.
 * @public Exercised by the bundled unit tests.
 */
export function receiptCondition(signals: ReadonlySet<string>): boolean {
	return (
		receiptScore(signals) >= RECEIPT_MODEL_THRESHOLD &&
		(signals.has("subject_keyword") || signals.has("invoice_attachment"))
	);
}

/**
 * The `wantsModel` hint (§5.7.2): a receipt-like message the detector could not read completely, with no
 * amount, no cycle, or neither a stated renewal date nor a trial end. Phishing and spam never ask.
 */
export function wantsModelForReceipt(input: DetectStepInput, timeZone: string): boolean {
	if (skipsMessage(input.facts)) return false;
	const analysis = analyzeMessage({ ...input, model: null }, timeZone);
	if (!analysis || !receiptCondition(analysis.signals)) return false;
	return !analysis.amount || !analysis.cycle || (!analysis.renewalOn && !analysis.trialEndsOn);
}

/** Only a message with an amount and no cycle, renewal or trial phrase looks at the sender's earlier mail. */
export function needsHistory(analysis: Analysis): boolean {
	return !!analysis.amount && !analysis.cycle && !analysis.renewalOn && !analysis.trialEndsOn;
}

export type HistoryMessage = { receivedAt: string; subject: string | null; textExcerpt: string | null };

/**
 * The cycle the sender's earlier mail implies: messages carrying the same amount and currency, at a
 * plausible interval from the next newer match (starting with this message). Null when none does.
 */
export function recurringCycle(analysis: Analysis, history: readonly HistoryMessage[], timeZone: string): Cycle | null {
	const amount = analysis.amount;
	if (!amount) return null;
	const matching = history
		.filter((item) =>
			parseAmounts(`${item.subject ?? ""}\n${item.textExcerpt ?? ""}`).some(
				(found) => found.minor === amount.minor && found.currency === amount.currency,
			),
		)
		.map((item) => dayInTimeZone(item.receivedAt, timeZone))
		.sort()
		.reverse();
	let newer = analysis.dates.messageDay;
	for (const day of matching) {
		const cycle = cycleFromInterval(daysBetween(day, newer));
		if (cycle) return cycle;
		newer = day;
	}
	return null;
}

/** The tracked row this message is about: same vendor key, then the same currency, then plan, then the closest amount. */
export function matchTracked<Row extends TrackedMatchRow>(
	rows: readonly Row[],
	analysis: Pick<Analysis, "vendorKey" | "plan" | "amount">,
): Row | null {
	const sameKey = rows.filter((row) => row.vendorKey === analysis.vendorKey);
	if (sameKey.length === 0) return null;
	const score = (row: TrackedMatchRow) => {
		const sameCurrency = !!analysis.amount && row.currency === analysis.amount.currency;
		const samePlan = !!analysis.plan && row.plan?.toLowerCase() === analysis.plan.toLowerCase();
		const distance =
			sameCurrency && row.amountMinor !== null ? Math.abs(row.amountMinor - analysis.amount!.minor) : Infinity;
		return { sameCurrency, samePlan, distance };
	};
	return [...sameKey].sort((a, b) => {
		const [x, y] = [score(a), score(b)];
		if (x.sameCurrency !== y.sameCurrency) return x.sameCurrency ? -1 : 1;
		if (x.samePlan !== y.samePlan) return x.samePlan ? -1 : 1;
		return x.distance - y.distance;
	})[0];
}

type Planned = { event: SubscriptionEvent; previousAmountMinor: number | null };

function trackedEvent(analysis: Analysis, row: TrackedMatchRow): Planned {
	const docType = analysis.document?.docType;
	if (docType === "failed_payment") return { event: "payment_failed", previousAmountMinor: null };
	if (docType === "credit" || docType === "refund") return { event: "refund", previousAmountMinor: null };
	const amount = analysis.amount;
	if (amount && row.amountMinor !== null && row.currency === amount.currency && row.amountMinor !== amount.minor)
		return { event: "price_change", previousAmountMinor: row.amountMinor };
	return { event: analysis.trialEndsOn ? "trial" : "renewal", previousAmountMinor: null };
}

/**
 * Recurrence evidence plus enough weight: what every card except a tracked row's refund or failed payment
 * needs. Model-filled fields count as evidence but add no weight; with any of them the deterministic
 * receipt condition replaces the weight of 4, so the model alone never makes a candidate (§5.7.4, rule 6).
 */
function meetsCandidateRule(analysis: Analysis, signals: Set<string>): boolean {
	if (!analysis.amount) return false;
	const recurrence = !!analysis.cycle || !!analysis.renewalOn || !!analysis.trialEndsOn || signals.has("recurring");
	if (!recurrence) return false;
	if (signalWeight(signals) >= CANDIDATE_WEIGHT) return true;
	return analysis.modelFields.length > 0 && receiptCondition(signals);
}

function plan(analysis: Analysis, row: TrackedMatchRow | null, signals: Set<string>): Planned | null {
	const docType = analysis.document?.docType;
	const moneyBack = docType === "credit" || docType === "refund" || docType === "failed_payment";
	if (!row) {
		if (moneyBack || !meetsCandidateRule(analysis, signals)) return null;
		return { event: analysis.trialEndsOn ? "trial" : "new", previousAmountMinor: null };
	}
	const planned = trackedEvent(analysis, row);
	if (planned.event === "payment_failed" || planned.event === "refund") return planned;
	return meetsCandidateRule(analysis, signals) ? planned : null;
}

const REASONS: Record<SubscriptionEvent, string> = {
	new: "subscription",
	renewal: "subscription",
	price_change: "subscription_price_change",
	trial: "subscription_trial",
	payment_failed: "subscription_payment_failed",
	refund: "subscription_refund",
};

function documentOf(document: ClassifiedDocument | null): DocumentInfo | null {
	if (!document) return null;
	const { docType, documentOn, periodStartOn, periodEndOn, attachmentId } = document;
	return { docType, documentOn, periodStartOn, periodEndOn, attachmentId };
}

function orderedSignals(signals: Set<string>): string[] {
	return SIGNAL_ORDER.filter((signal) => signals.has(signal)).slice(0, MAX_SIGNALS);
}

export type DetectionContext = {
	tracked: TrackedMatchRow | null;
	/** The cycle the sender's earlier mail implies, when it was read. */
	recurring: Cycle | null;
};

/** The suggestion payload and reason for one message, or null when it is not a subscription card. */
export function buildDetection(
	analysis: Analysis,
	context: DetectionContext,
): { payload: SubscriptionPayload; reason: string } | null {
	const signals = new Set(analysis.signals);
	if (context.tracked || context.recurring) signals.add("recurring");
	const planned = plan(analysis, context.tracked, signals);
	if (!planned) return null;
	const cycle = analysis.cycle ?? context.recurring ?? context.tracked?.cycle ?? null;
	const estimated = !analysis.renewalOn && cycle !== null;
	const amount = analysis.amount;
	const checkAmount =
		analysis.modelDisagrees.length > 0 && planned.event !== "payment_failed" && planned.event !== "refund";
	return {
		reason: checkAmount ? "subscription_check_amount" : REASONS[planned.event],
		payload: {
			event: planned.event,
			subscriptionId: context.tracked?.id ?? null,
			vendor: analysis.vendor,
			vendorKey: analysis.vendorKey,
			plan: analysis.plan,
			amountMinor: amount?.minor ?? null,
			currency: amount?.currency ?? null,
			previousAmountMinor: planned.previousAmountMinor,
			cycle,
			nextRenewalOn: analysis.renewalOn ?? (cycle ? nextAfter(analysis.dates.messageDay, cycle) : null),
			renewalEstimated: estimated,
			trialEndsOn: analysis.trialEndsOn,
			cancelLink: analysis.cancelLink,
			document: documentOf(analysis.document),
			unverified: analysis.unverified,
			signals: orderedSignals(signals),
			modelFields: [...analysis.modelFields],
			modelDisagrees: [...analysis.modelDisagrees],
		},
	};
}
