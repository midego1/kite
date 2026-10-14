/** Calendar dates as `YYYY-MM-DD`, and the date formats receipts use in the five supported languages. */

const MONTH_NAMES: Record<string, number> = {};
const MONTH_LISTS: string[][] = [
	["january", "jan", "januari", "januar", "jänner", "janvier", "janv", "enero", "ene"],
	["february", "feb", "februari", "februar", "février", "fevrier", "févr", "fevr", "febrero"],
	["march", "mar", "maart", "mrt", "märz", "mär", "mars", "marzo"],
	["april", "apr", "avril", "avr", "abril", "abr"],
	["may", "mei", "mai", "mayo"],
	["june", "jun", "juni", "juin", "junio"],
	["july", "jul", "juli", "juillet", "juil", "julio"],
	["august", "aug", "augustus", "août", "aout", "agosto", "ago"],
	["september", "sep", "sept", "septembre", "septiembre", "setiembre"],
	["october", "oct", "oktober", "okt", "octobre", "octubre"],
	["november", "nov", "novembre", "noviembre"],
	["december", "dec", "dezember", "dez", "décembre", "decembre", "diciembre", "dic", "déc"],
];
MONTH_LISTS.forEach((names, index) => names.forEach((name) => (MONTH_NAMES[name] = index + 1)));

const MONTH = `(?:${Object.keys(MONTH_NAMES)
	.sort((a, b) => b.length - a.length)
	.join("|")})(?![\\p{L}])`;

const DATE_PATTERN = new RegExp(
	[
		"(?<![\\p{L}\\p{N}])(?:",
		"(\\d{4})-(\\d{2})-(\\d{2})(?![\\p{N}])",
		"|(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4})(?![\\p{N}])",
		`|(\\d{1,2})(?:st|nd|rd|th|er|\\.)?\\s+(?:de\\s+)?(${MONTH})\\.?(?:,?\\s+(?:de\\s+)?(\\d{4})(?![\\p{N}]))?`,
		`|(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{N}])(?:,?\\s+(\\d{4})(?![\\p{N}]))?`,
		")",
	].join(""),
	"giu",
);

const DAY_MS = 86_400_000;

/** How numeric dates are read: day first unless the receipt is in USD or from a `.us` domain. */
export type DateContext = { messageDay: string; monthFirst: boolean };

export type DayWindow = { from: string; to: string };

export type FoundDate = {
	year: number | null;
	month: number;
	day: number;
	/** A numeric date whose two parts could both be the month. */
	ambiguous: boolean;
	index: number;
	end: number;
};

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

export function formatDay(year: number, month: number, day: number): string {
	return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function dayTime(day: string): number {
	return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

function fromTime(time: number): string {
	const date = new Date(time);
	return formatDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function isRealDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1 || year < 1000 || year > 9999) return false;
	return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

/** A `YYYY-MM-DD` string that names a real date. */
export function isDayString(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	return !!match && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function addDays(day: string, days: number): string {
	return fromTime(dayTime(day) + days * DAY_MS);
}

/** Whole months later, keeping the day of the month where it exists (31 Jan + 1 month is 28 or 29 Feb). */
export function addMonths(day: string, months: number): string {
	const total = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + months;
	const year = Math.floor(total / 12);
	const month = (total % 12) + 1;
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return formatDay(year, month, Math.min(Number(day.slice(8, 10)), last));
}

export function daysBetween(from: string, to: string): number {
	return Math.round((dayTime(to) - dayTime(from)) / DAY_MS);
}

/** The calendar date of an instant in a time zone; UTC when the zone is unknown. */
export function dayInTimeZone(iso: string, timeZone: string): string {
	const date = new Date(iso);
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
			date,
		);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}

export function inWindow(day: string, window: DayWindow): boolean {
	return day >= window.from && day <= window.to;
}

/** The bounds of a stated renewal or trial date: 31 days before the message to 2 years after it. */
export function receiptWindow(messageDay: string): DayWindow {
	return { from: addDays(messageDay, -31), to: addMonths(messageDay, 24) };
}

function numericDate(a: number, b: number, year: number, monthFirst: boolean) {
	const [month, day] = monthFirst ? [a, b] : [b, a];
	if (isRealDate(year, month, day)) return { year, month, day, ambiguous: a <= 12 && b <= 12 && a !== b };
	if (isRealDate(year, day, month)) return { year, month: day, day: month, ambiguous: false };
	return null;
}

function monthOf(name: string): number {
	return MONTH_NAMES[name.toLowerCase()] ?? 0;
}

type Parts = Omit<FoundDate, "index" | "end">;

function partsOf(match: RegExpMatchArray, monthFirst: boolean): Parts | null {
	const n = (index: number) => (match[index] === undefined ? null : Number(match[index]));
	if (match[1]) return { year: n(1), month: n(2)!, day: n(3)!, ambiguous: false };
	if (match[4]) return numericDate(n(4)!, n(5)!, n(6)!, monthFirst);
	if (match[7]) return { year: n(9), month: monthOf(match[8]), day: n(7)!, ambiguous: false };
	return { year: n(12), month: monthOf(match[10]), day: n(11)!, ambiguous: false };
}

/** Every date the text writes, with its parts; a date without a year keeps `year: null`. */
export function scanDates(text: string, monthFirst: boolean): FoundDate[] {
	const found: FoundDate[] = [];
	for (const match of text.matchAll(DATE_PATTERN)) {
		const parts = partsOf(match, monthFirst);
		if (!parts || !isRealDate(parts.year ?? 2000, parts.month, parts.day)) continue;
		found.push({ ...parts, index: match.index, end: match.index + match[0].length });
	}
	return found;
}

/** The date as `YYYY-MM-DD`; a date without a year takes its next occurrence on or after the message date.
 * @public Exercised by the bundled unit tests.
 */
export function resolveDay(found: Pick<FoundDate, "year" | "month" | "day">, messageDay: string): string | null {
	if (found.year !== null)
		return isRealDate(found.year, found.month, found.day) ? formatDay(found.year, found.month, found.day) : null;
	const year = Number(messageDay.slice(0, 4));
	for (const candidate of [year, year + 1])
		if (isRealDate(candidate, found.month, found.day)) {
			const day = formatDay(candidate, found.month, found.day);
			if (day >= messageDay) return day;
		}
	return null;
}

/** The resolved date when it lies in the window; an ambiguous numeric date also has to be within 31 days of the message. */
export function acceptDay(found: FoundDate, ctx: DateContext, window: DayWindow): string | null {
	const day = resolveDay(found, ctx.messageDay);
	if (!day || !inWindow(day, window)) return null;
	if (found.ambiguous && Math.abs(daysBetween(ctx.messageDay, day)) > 31) return null;
	return day;
}

function globalOf(pattern: RegExp): RegExp {
	return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/** How far after a phrase its date may start. */
const PHRASE_REACH = 60;

/** The first acceptable date within a short reach after any match of the phrase, or null. */
export function dateAfterPhrase(text: string, phrase: RegExp, ctx: DateContext, window: DayWindow): string | null {
	for (const match of text.matchAll(globalOf(phrase))) {
		const start = match.index + match[0].length;
		const [first] = scanDates(text.slice(start, start + PHRASE_REACH), ctx.monthFirst);
		const day = first ? acceptDay(first, ctx, window) : null;
		if (day) return day;
	}
	return null;
}
