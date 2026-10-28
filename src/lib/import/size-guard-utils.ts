import { DATABASE_STOP_RATIO, type DatabaseSize } from "@/lib/db/size-utils";

/** A confirmed import may keep going above the stop ratio, up to this share of the limit. */
const CONFIRMED_STOP_RATIO = 0.98;

/** Set on a job that was started or resumed with "Import anyway"; the next size check reads it back. */
export const IMPORT_CONFIRMED_NOTE = "Continuing above 90% of the database limit, as confirmed.";

const DATABASE_NEARLY_FULL_NOTE =
	"Paused: the database is above 90% of its size limit. Free space, or resume and confirm to continue anyway.";

const DATABASE_FULL_NOTE =
	"Paused: the database is almost at its size limit. Free space or raise the limit before resuming.";

export function isImportConfirmed(lastError: string | null): boolean {
	return lastError === IMPORT_CONFIRMED_NOTE;
}

/** What a job keeps in `lastError` when it hands itself to the next run: the confirmation, never an old error. */
export function carriedImportNote(lastError: string | null): string | null {
	return isImportConfirmed(lastError) ? lastError : null;
}

/**
 * What a running import does after a batch: keep going, or pause with the message to show. An unconfirmed import
 * stops at 90% of the limit, a confirmed one at 98%. No limit (Node) never pauses.
 */
export function importPauseNote(size: DatabaseSize | null, lastError: string | null): string | null {
	if (!size?.limitBytes) return null;
	const ratio = size.usedBytes / size.limitBytes;
	if (ratio >= CONFIRMED_STOP_RATIO) return DATABASE_FULL_NOTE;
	if (ratio >= DATABASE_STOP_RATIO && !isImportConfirmed(lastError)) return DATABASE_NEARLY_FULL_NOTE;
	return null;
}

/** Starting or resuming needs "Import anyway" when the database is already above 90% of its limit. */
export function needsStartConfirmation(size: DatabaseSize | null): boolean {
	return !!size?.limitBytes && size.usedBytes / size.limitBytes >= DATABASE_STOP_RATIO;
}
