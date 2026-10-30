import type { MigrationApplyResponse } from "./migrations-banner-types";
import { migrationApplySummary } from "./migrations-banner-utils";

export type MigrationStepState = "done" | "active" | "waiting";

interface MigrationProgressStep {
	id: "backup" | "apply";
	label: string;
	state: MigrationStepState;
}

export interface MigrationProgressView {
	steps: MigrationProgressStep[];
	/** Updates finished so far, from the pending list shrinking as each one is recorded. */
	done: number;
	total: number;
	/** Shown under the steps once the connection dropped while the server may still be migrating. */
	notice: string | null;
	/** The text a screen reader hears; it changes only when a step does, never every second. */
	announcement: string;
}

const NAMES_SHOWN = 3;

const CONNECTION_LOST_NOTICE = "The connection timed out; the update may still be running — checking…";

/** "12 s", "1 min 05 s": a live counter so a long update never looks frozen. */
export function formatElapsed(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	if (whole < 60) return `${whole} s`;
	return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** "0081_a.sql, 0082_b.sql" with a tail when there are many. */
function summarizeMigrationNames(names: string[]): string {
	if (names.length <= NAMES_SHOWN) return names.join(", ");
	return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${names.length - NAMES_SHOWN} more`;
}

function updatesText(count: number): string {
	return `${count} ${count === 1 ? "update" : "updates"}`;
}

/**
 * The steps of a running update. The server applies migrations one at a time, so the pending list read
 * during the request shrinks as they land; until the first one lands the safety backup is the step in progress.
 */
export function migrationProgressView(
	startNames: string[],
	remaining: string[] | null,
	recovering = false,
): MigrationProgressView {
	const total = startNames.length;
	const left = remaining ? remaining.filter((name) => startNames.includes(name)).length : total;
	const done = Math.min(total, Math.max(0, total - left));
	const started = done > 0;
	const names = total ? ` (${summarizeMigrationNames(startNames)})` : "";
	const applying = total ? `Applying ${updatesText(total)}` : "Applying the updates";

	const backupLabel = started ? "Safety backup finished" : "Saving a safety backup, then applying…";
	const applyLabel = started ? `${applying}: ${done} of ${total} done…` : `${applying}${names}`;
	return {
		steps: [
			{ id: "backup", label: backupLabel, state: started ? "done" : "active" },
			{ id: "apply", label: applyLabel, state: started ? "active" : "waiting" },
		],
		done,
		total,
		notice: recovering ? CONNECTION_LOST_NOTICE : null,
		announcement: `${started ? `${applying}, ${done} of ${total} done.` : "Saving a safety backup, then applying."}${recovering ? ` ${CONNECTION_LOST_NOTICE}` : ""}`,
	};
}

/** What the primary admin reads after a successful run. */
export function migrationDoneSummary(result: MigrationApplyResponse, elapsedSeconds: number): string {
	const took = elapsedSeconds >= 1 ? ` Took ${formatElapsed(elapsedSeconds)}.` : "";
	return `${migrationApplySummary(result)}${took}`;
}

const RESTORE_RUNNING_MESSAGE =
	"The database was not changed: a backup restore is running. Apply the updates once it has finished (see Backups).";

/** The message for a run that did not finish and was not a dropped connection. */
export function migrationApplyFailure(status: number, serverMessage: string | undefined): string {
	if (status === 409) return RESTORE_RUNNING_MESSAGE;
	const reason = serverMessage?.trim() || `The server answered ${status}`;
	const kept = /nothing was changed/.test(reason) ? "" : " Updates that already finished stay applied.";
	return `The database update failed. ${reason}${/[.!]$/.test(reason) ? "" : "."}${kept}`;
}

/** After a dropped connection, the pending list stopped changing: whether it finished is not known. */
export const MIGRATION_OUTCOME_UNKNOWN =
	"It is not known whether the database update finished: the connection timed out and the list of waiting updates showed no progress. Check the Backups page and the list above, and try again later.";

/** What the admin reads when the list emptied after the connection dropped, so the backup is not confirmed. */
export function migrationRecoveredSummary(applied: string[], elapsedSeconds: number): string {
	return `${migrationDoneSummary({ applied }, elapsedSeconds)} The connection dropped meanwhile, so check the Backups page for the safety backup.`;
}
