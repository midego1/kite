/** How far ahead of the server's clock an imported date may be, for a source whose clock runs a little fast. */
const IMPORT_FUTURE_SKEW_MS = 24 * 60 * 60_000;

/**
 * The date an imported message is stored with: the first candidate (the `Date` header, then the source's
 * INTERNALDATE) that is not more than `IMPORT_FUTURE_SKEW_MS` in the future, else `now`. A source could otherwise
 * date its mail years ahead and pin it to the top of every list.
 */
export function importMessageDate(candidates: ReadonlyArray<Date | null | undefined>, now: Date): Date {
	const latest = now.getTime() + IMPORT_FUTURE_SKEW_MS;
	return candidates.find((date) => date && !Number.isNaN(date.getTime()) && date.getTime() <= latest) ?? now;
}
