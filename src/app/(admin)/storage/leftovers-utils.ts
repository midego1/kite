import { KEPT_REASON_TEXT, type LeftoverKeptReason } from "@/lib/storage/cold-leftovers-utils";
import type { LeftoverRunView } from "./types";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "a backup you keep could still restore a reference to it (2); …", most common reason first. */
export function keptReasonsText(kept: Partial<Record<LeftoverKeptReason, number>>): string {
	return (Object.entries(kept) as [LeftoverKeptReason, number][])
		.filter(([, count]) => count > 0)
		.sort(([, a], [, b]) => b - a)
		.map(([reason, count]) => `${KEPT_REASON_TEXT[reason]} (${count.toLocaleString()})`)
		.join("; ");
}

/** One sentence about what a cleanup run did, for the status line after "Delete leftovers" or the last run;
 * `reasons: false` leaves out why copies were kept, for a page that lists those on a line of their own. */
export function leftoverRunText(run: LeftoverRunView, { reasons = true }: { reasons?: boolean } = {}): string {
	if (run.skipped === "restore")
		return "Nothing was deleted: a backup restore is running, needs recovery or just finished.";
	if (run.skipped === "unsupported") return "Nothing was deleted: apply the pending database update first.";
	if (!run.checked) return "No leftover copies are past the grace period yet.";
	const parts = [`Deleted ${plural(run.deleted, "leftover copy", "leftover copies")}.`];
	if (run.cleared) parts.push(`${plural(run.cleared, "copy was", "copies were")} already gone or in use again.`);
	const keptCount = Object.values(run.kept).reduce((sum, count) => sum + (count ?? 0), 0);
	if (keptCount)
		parts.push(
			reasons
				? `Kept ${keptCount.toLocaleString()}: ${keptReasonsText(run.kept)}.`
				: `Kept ${keptCount.toLocaleString()}.`,
		);
	return parts.join(" ");
}

/** "3 left on this store" after a manual run, so the admin knows whether another click is worth it. */
export function remainingText(remaining: number, storeScoped: boolean): string {
	if (!remaining) return storeScoped ? "No leftover copies are left on this store." : "No leftover copies are left.";
	return `${plural(remaining, "leftover copy is", "leftover copies are")} still tracked${storeScoped ? " on this store" : ""}.`;
}

export type GraceForm = { automatic: boolean; graceDays: string };

/** The settings body from the form, or the message to show under the grace period field. */
export function graceFormToBody(
	form: GraceForm,
	limits: { min: number; max: number },
): { body: { automatic: boolean; graceDays: number } } | { error: string } {
	const days = Number(form.graceDays.trim());
	if (!form.graceDays.trim() || !Number.isInteger(days) || days < limits.min || days > limits.max)
		return { error: `Enter a grace period from ${limits.min} to ${limits.max} days` };
	return { body: { automatic: form.automatic, graceDays: days } };
}
