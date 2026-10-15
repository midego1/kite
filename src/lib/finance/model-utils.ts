import { isCurrencyCode, MAX_AMOUNT_MINOR, minorDigits } from "./amount-utils";
import { addDays, addMonths, isDayString } from "./date-utils";
import type { Analysis } from "./detect-utils";
import { financeModelSchema } from "./model-schema";
import type { Cycle, DetectStepInput, DocType, ModelField } from "./types";
import { cleanText, cleanVendorName } from "./vendor-utils";

const MAX_PLAN = 80;
const MAX_YEARS_AHEAD = 2;

/** The model's answer under `modules.finance` after validation: only the fields that passed (spec §5.7.4). */
export type ModelExtraction = {
	vendor?: string;
	plan?: string;
	amount?: { minor: number; currency: string };
	cycle?: Cycle;
	nextRenewalOn?: string;
	trialEndsOn?: string;
	docType?: DocType;
};

type ExtractionContext = {
	/** The message date as a calendar day in the reviewer's time zone. */
	messageDay: string;
	/** Whether the deterministic payment-failed phrases matched; only then may the model say `failed_payment`. */
	paymentFailed: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The untrusted object core handed this step under `model.modules.finance`, or undefined. */
export function modelExtensionOf(input: Pick<DetectStepInput, "model">): unknown {
	const modules = input.model?.modules;
	return isPlainObject(modules) ? modules.finance : undefined;
}

type FieldName = keyof typeof financeModelSchema.shape;

/** One field validated on its own against the module's schema; anything invalid or null is absent. */
function field(raw: Record<string, unknown>, name: FieldName): string | undefined {
	if (!Object.hasOwn(raw, name)) return undefined;
	const parsed = financeModelSchema.shape[name].safeParse(raw[name]);
	return parsed.success && typeof parsed.data === "string" ? parsed.data : undefined;
}

/** A decimal string in minor units, only with no fraction or exactly the currency's minor digits, within the bounds. */
function modelAmount(amount: string | undefined, currency: string | undefined) {
	if (amount === undefined || currency === undefined || !isCurrencyCode(currency)) return undefined;
	const digits = minorDigits(currency);
	const [whole, fraction] = amount.split(".");
	if (fraction !== undefined && fraction.length !== digits) return undefined;
	const minor = Number(whole) * 10 ** digits + Number((fraction ?? "").padEnd(digits, "0") || "0");
	if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT_MINOR) return undefined;
	return { minor, currency };
}

/** A real calendar day from one day before the message (time zone tolerance) to two years after it. */
function modelDay(value: string | undefined, messageDay: string): string | undefined {
	if (value === undefined || !isDayString(value)) return undefined;
	if (value < addDays(messageDay, -1) || value > addMonths(messageDay, MAX_YEARS_AHEAD * 12)) return undefined;
	return value;
}

function present<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Validates the model's `modules.finance` object field by field (spec §5.7.4). A value that is not an
 * object is absent; unknown keys (a `cancelUrl`, a `link`) are never read; each invalid field is absent.
 * Null when nothing valid is left.
 */
export function parseModelExtraction(raw: unknown, context: ExtractionContext): ModelExtraction | null {
	if (!isPlainObject(raw)) return null;
	const vendor = cleanVendorName(field(raw, "vendor") ?? "");
	const plan = cleanText(field(raw, "plan") ?? "", MAX_PLAN);
	const docType = field(raw, "docType") as DocType | undefined;
	const extraction = present<ModelExtraction>({
		vendor: vendor || undefined,
		plan: plan || undefined,
		amount: modelAmount(field(raw, "amount"), field(raw, "currency")),
		cycle: field(raw, "cycle") as Cycle | undefined,
		nextRenewalOn: modelDay(field(raw, "nextRenewalOn"), context.messageDay),
		trialEndsOn: modelDay(field(raw, "trialEndsOn"), context.messageDay),
		docType: docType === "failed_payment" && !context.paymentFailed ? undefined : docType,
	});
	return Object.keys(extraction).length > 0 ? extraction : null;
}

/** The fields where the model disagreed with a confident deterministic amount or currency.
 * @public Exercised by the bundled unit tests.
 */
export function modelDisagrees(
	deterministic: Analysis["amount"],
	model: ModelExtraction["amount"],
): ("amount" | "currency")[] {
	if (!deterministic || !model) return [];
	const fields: ("amount" | "currency")[] = [];
	if (deterministic.minor !== model.minor) fields.push("amount");
	if (deterministic.currency !== model.currency) fields.push("currency");
	return fields;
}

/** The fields a validated model value fills, in the payload's order, given what the detector found.
 * @public Exercised by the bundled unit tests.
 */
export function modelFields(deterministic: Analysis, model: ModelExtraction): ModelField[] {
	const fills: [ModelField[], boolean][] = [
		[["vendor"], !!model.vendor && deterministic.vendorFromDomain],
		[["plan"], !!model.plan && !deterministic.plan],
		[["amount", "currency"], !!model.amount && !deterministic.amount],
		[["cycle"], !!model.cycle && !deterministic.cycle],
		[["nextRenewalOn"], !!model.nextRenewalOn && !deterministic.renewalOn],
		[["trialEndsOn"], !!model.trialEndsOn && !deterministic.trialEndsOn],
		[["docType"], fillsDocType(deterministic, model)],
	];
	return fills.flatMap(([names, fills]) => (fills ? names : []));
}

/** A model document type replaces only a body-only or missing classification, and money documents need an amount. */
function fillsDocType(deterministic: Analysis, model: ModelExtraction): boolean {
	const docType = model.docType;
	if (!docType || docType === "failed_payment") return false;
	const current = deterministic.classified;
	if (current?.confident || current?.docType === docType) return false;
	return !!(deterministic.amount ?? model.amount);
}

/** The merged document: the model's type when it filled one, else the detector's type once an amount is known. */
function mergedDocument(
	deterministic: Analysis,
	model: ModelExtraction,
	docFilled: boolean,
	hasAmount: boolean,
): Analysis["document"] {
	if (docFilled) return { docType: model.docType!, ...deterministic.documentDetails, confident: false };
	if (deterministic.document || !deterministic.classified || !hasAmount) return deterministic.document;
	return { ...deterministic.classified, ...deterministic.documentDetails };
}

function withDocSignal(signals: ReadonlySet<string>, document: Analysis["document"]): Set<string> {
	const next = new Set(signals);
	for (const signal of [...next]) if (signal.startsWith("doc_")) next.delete(signal);
	if (document && document.docType !== "failed_payment") next.add(`doc_${document.docType}`);
	next.add("model_fields");
	return next;
}

/**
 * The detector's analysis with the validated model values merged in (spec §5.7.4). A confident
 * deterministic value always wins; the model fills empty fields and replaces only a domain-fallback
 * vendor, an estimated renewal and a body-only document type. A document type the detector classified
 * without an amount becomes the document once the model supplies the amount. The vendor key, the event,
 * the cancel link, a failed payment and the document's date, period and attachment never come from the model.
 */
export function mergeDetection(deterministic: Analysis, model: ModelExtraction | null): Analysis {
	if (!model) return deterministic;
	const disagrees = modelDisagrees(deterministic.amount, model.amount);
	const fields = modelFields(deterministic, model);
	if (fields.length === 0) return { ...deterministic, modelDisagrees: disagrees };
	const has = (name: ModelField) => fields.includes(name);
	const amount = has("amount") ? model.amount! : deterministic.amount;
	const document = mergedDocument(deterministic, model, has("docType"), amount !== null);
	return {
		...deterministic,
		vendor: has("vendor") ? model.vendor! : deterministic.vendor,
		vendorFromDomain: has("vendor") ? false : deterministic.vendorFromDomain,
		plan: has("plan") ? model.plan! : deterministic.plan,
		amount,
		cycle: has("cycle") ? model.cycle! : deterministic.cycle,
		renewalOn: has("nextRenewalOn") ? model.nextRenewalOn! : deterministic.renewalOn,
		trialEndsOn: has("trialEndsOn") ? model.trialEndsOn! : deterministic.trialEndsOn,
		document,
		signals: withDocSignal(deterministic.signals, document),
		modelFields: fields,
		modelDisagrees: disagrees,
	};
}
