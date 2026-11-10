import { migrationLabel } from "./migration-label-utils";
import type { MigrationProgressView } from "./migration-progress-utils";

/** What the notice is doing: waiting for an admin to press the button, running, or showing why the last run stopped. */
export type MigrationNoticeState = "pending" | "applying" | "failed";

/** Which sentence the status line of a running update shows. */
export type MigrationNoticePhase = "backup" | "applying" | "elsewhere";

/** A run in progress always wins; an error is only shown once nothing runs, so Retry never sits beside a spinner. */
export function migrationNoticeState({ busy, error }: { busy: boolean; error: string | null }): MigrationNoticeState {
	if (busy) return "applying";
	return error ? "failed" : "pending";
}

/**
 * The status of a running update. A run another tab or the admin card started has no steps here, so it only
 * says it is going on; this tab's own run is the backup until the first update lands. A dropped connection is
 * not a phase: the count stays and the hint line says it is being checked.
 */
export function migrationNoticePhase(view: MigrationProgressView, ownsRun: boolean): MigrationNoticePhase {
	if (!ownsRun) return "elsewhere";
	return view.done > 0 && view.total > 0 ? "applying" : "backup";
}

/** The bar's fill from 0 to 100, or null while the length of the run is not known yet (an indeterminate bar). */
export function migrationProgressPercent(done: number, total: number): number | null {
	if (total <= 0 || done <= 0) return null;
	return Math.min(100, Math.round((done / total) * 100));
}

/** The waiting updates in words, one line each and without repeats; the file names stay out of the notice. */
export function migrationDetailLabels(names: string[] | undefined): string[] {
	return [...new Set((names ?? []).map(migrationLabel))];
}
