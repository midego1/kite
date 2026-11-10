import { formatDriveSize } from "@/lib/drive/name-utils";
import type { ColdJobView, ColdRuleView } from "./types";

export const COLD_QUERY_KEY = ["admin-storage-cold"];

/** The sentinel `target` that rewrites an object in place to the default store's Infrequent Access class. */
export const R2_IA_TARGET = "r2-ia";

const MB = 1024 * 1024;

/** `""` means no size floor (every age-eligible object qualifies). */
function parseMinBytesMb(value: string): { bytes: number } | { error: string } {
	const trimmed = value.trim();
	if (!trimmed) return { bytes: 0 };
	const mb = Number(trimmed);
	if (!Number.isFinite(mb) || mb < 0) return { error: "Enter a minimum size of 0 or more MB, or leave it empty" };
	return { bytes: Math.round(mb * MB) };
}

function minBytesToMb(bytes: number): string {
	if (bytes <= 0) return "";
	const rounded = Math.round((bytes / MB) * 100) / 100;
	// A threshold small enough to round to "0.00 MB" must still show as nonzero, or saving the form again
	// without touching this field would reparse it as 0 and silently drop the floor.
	return String(rounded > 0 ? rounded : bytes / MB);
}

function parseAfterDays(value: string, max: number): { days: number } | { error: string } {
	const days = Number(value.trim());
	if (!value.trim() || !Number.isInteger(days) || days < 1 || days > max)
		return { error: `Enter an age from 1 to ${max.toLocaleString()} days` };
	return { days };
}

const JOB_LABELS: Record<ColdJobView["status"], string> = {
	queued: "Waiting to start",
	running: "Moving objects",
	completed: "Up to date",
	failed: "Stopped after repeated errors",
};

export function coldJobLabel(job: ColdJobView | undefined): string {
	return job ? JOB_LABELS[job.status] : "Never run";
}

export function coldJobSummary(job: ColdJobView | undefined): string | null {
	if (!job) return null;
	const objects = `${job.objectsDone.toLocaleString()} ${job.objectsDone === 1 ? "object" : "objects"}`;
	const errors = job.errors ? `, ${job.errors.toLocaleString()} errors` : "";
	return `${objects} moved, ${formatDriveSize(job.bytesDone)}${errors}`;
}

export function isColdJobRunning(job: ColdJobView | undefined): boolean {
	return job?.status === "queued" || job?.status === "running";
}

export type ColdRuleForm = { afterDays: string; minBytesMb: string; target: string; enabled: boolean };

export function coldRuleToForm(rule: ColdRuleView): ColdRuleForm {
	return {
		afterDays: String(rule.afterDays),
		minBytesMb: minBytesToMb(rule.minBytes),
		target: rule.target,
		enabled: rule.enabled,
	};
}

const COLD_MAX_AFTER_DAYS = 3650;

export function coldRuleToBody(
	form: ColdRuleForm,
): { body: { afterDays: number; minBytes: number; target: string; enabled: boolean } } | { error: string } {
	const days = parseAfterDays(form.afterDays, COLD_MAX_AFTER_DAYS);
	if ("error" in days) return days;
	const size = parseMinBytesMb(form.minBytesMb);
	if ("error" in size) return size;
	return { body: { afterDays: days.days, minBytes: size.bytes, target: form.target, enabled: form.enabled } };
}
