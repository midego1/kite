/** ISO 4217 codes Money Watch accepts, from mail and from the model alike. */
const CURRENCY_CODES: ReadonlySet<string> = new Set(
	(
		"AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD " +
		"CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF " +
		"GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP " +
		"LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB " +
		"PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB " +
		"TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL"
	).split(" "),
);

const ZERO_DIGITS = new Set("BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF".split(" "));
const THREE_DIGITS = new Set("BHD IQD JOD KWD LYD OMR TND".split(" "));

/** Whether a code is on the ISO 4217 allowlist. */
export function isCurrencyCode(code: string): boolean {
	return CURRENCY_CODES.has(code);
}

/** The most an amount may be, in minor units (1,000,000.00 in a two-digit currency).
 * @public Exercised by the bundled unit tests.
 */
export const MAX_AMOUNT_MINOR = 100_000_000;

/** @public Exercised by the bundled unit tests. */
export function minorDigits(currency: string): number {
	if (ZERO_DIGITS.has(currency)) return 0;
	return THREE_DIGITS.has(currency) ? 3 : 2;
}

const SYMBOLS: Record<string, string> = {
	"€": "EUR",
	"£": "GBP",
	"¥": "JPY",
	"₹": "INR",
	US$: "USD",
	CA$: "CAD",
	C$: "CAD",
	A$: "AUD",
	AU$: "AUD",
	NZ$: "NZD",
	HK$: "HKD",
	S$: "SGD",
	MX$: "MXN",
	R$: "BRL",
};

const SYMBOL = "US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|HK\\$|S\\$|MX\\$|R\\$|\\$|€|£|¥|₹";
const NUMBER = "\\d(?:[\\d.,]*\\d)?";
const GAP = "[ \\u00a0]?";
const AMOUNT_PATTERN = new RegExp(
	`(?<![\\p{L}\\d])(?:(${SYMBOL}|[A-Z]{3})${GAP}(${NUMBER})|(${NUMBER})${GAP}(${SYMBOL}|[A-Z]{3})(?![\\p{L}]))`,
	"gu",
);
const CODE_IN_LINE = /(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/g;

export type ParsedAmount = {
	minor: number;
	currency: string;
	/** Offset of the match in the text. */
	index: number;
	/** The line the amount is on, for the "same line" rules. */
	line: string;
};

/** Integer minor units for a number written with the currency's minor digits, or null when it cannot be read that way.
 * @public Exercised by the bundled unit tests.
 */
export function toMinorUnits(number: string, digits: number): number | null {
	const last = Math.max(number.lastIndexOf("."), number.lastIndexOf(","));
	let whole = number;
	let fraction = "";
	if (last >= 0 && digits > 0 && number.length - last - 1 === digits) {
		whole = number.slice(0, last);
		fraction = number.slice(last + 1);
	}
	const groups = whole.split(/[.,]/);
	if (groups.length > 1 && (groups[0].length > 3 || groups.slice(1).some((group) => group.length !== 3))) return null;
	const value = Number(groups.join("") + fraction.padEnd(digits, "0"));
	return Number.isSafeInteger(value) ? value : null;
}

/** The currency on the same line as a bare `$`: a code wins, else USD. */
function dollarCurrency(line: string): string {
	for (const match of line.matchAll(CODE_IN_LINE)) if (CURRENCY_CODES.has(match[0])) return match[0];
	return "USD";
}

function currencyOf(token: string, line: string): string | null {
	if (token === "$") return dollarCurrency(line);
	if (SYMBOLS[token]) return SYMBOLS[token];
	return CURRENCY_CODES.has(token) ? token : null;
}

function lineAround(text: string, index: number): string {
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index);
	return text.slice(start, end === -1 ? text.length : end);
}

/** Every currency amount in the text that reads cleanly and lies within the bounds. */
export function parseAmounts(text: string): ParsedAmount[] {
	const found: ParsedAmount[] = [];
	for (const match of text.matchAll(AMOUNT_PATTERN)) {
		const token = match[1] ?? match[4];
		const number = match[2] ?? match[3];
		const line = lineAround(text, match.index);
		const currency = currencyOf(token, line);
		if (!currency) continue;
		const minor = toMinorUnits(number, minorDigits(currency));
		if (minor === null || minor <= 0 || minor > MAX_AMOUNT_MINOR) continue;
		found.push({ minor, currency, index: match.index, line });
	}
	return found;
}

/**
 * The amount a receipt is about: one on the same line as a cycle or total phrase first, then the
 * largest under 10,000 in its currency, then the first.
 */
export function pickAmount(amounts: ParsedAmount[], preferredLine: (line: string) => boolean): ParsedAmount | null {
	if (amounts.length === 0) return null;
	const preferred = amounts.filter((amount) => preferredLine(amount.line));
	const pool = preferred.length > 0 ? preferred : amounts;
	const capped = pool.filter((amount) => amount.minor < 10_000 * 10 ** minorDigits(amount.currency));
	if (capped.length === 0) return pool[0];
	return capped.reduce((best, amount) => (amount.minor > best.minor ? amount : best));
}

/** The decimal string of an amount, "17.99" for 1799 USD.
 * @public Exercised by the bundled unit tests.
 */
export function formatDecimal(minor: number, currency: string): string {
	const digits = minorDigits(currency);
	if (digits === 0) return String(minor);
	const text = String(minor).padStart(digits + 1, "0");
	return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** The amount in the reviewer's locale, "$17.99"; falls back to the code and the decimal string. */
export function formatMoney(minor: number, currency: string, locale: string): string {
	const digits = minorDigits(currency);
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(minor / 10 ** digits);
	} catch {
		return `${currency} ${formatDecimal(minor, currency)}`;
	}
}
