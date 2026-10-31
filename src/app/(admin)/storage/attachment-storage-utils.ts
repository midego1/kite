import { formatDriveSize } from "@/lib/drive/name-utils";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { AttachmentStorageJobView } from "@/lib/email/attachment-storage-jobs-types";
import type { AttachmentStorageReport } from "./attachment-storage-types";

export const ATTACHMENT_STORAGE_QUERY_KEY = ["admin-attachment-storage"];

/** The runbook section that says what to do before running an older release. */
export const ATTACHMENT_ROLLBACK_URL = `${SOURCE_CODE_URL}/blob/main/docs/runbooks/recovery.md#materialize-then-roll-back`;

const files = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;

export function isJobRunning(job: AttachmentStorageJobView | null): boolean {
	return job?.status === "running";
}

const RUNNING_LABELS: Record<AttachmentStorageJobView["phase"], string> = {
	reclaim: "Reclaiming space",
	materialize: "Restoring separate copies",
	unshare: "Giving shared files their own copy",
};

/** One line for the job's state. */
export function jobHeadline(job: AttachmentStorageJobView): string {
	const name = job.direction === "reclaim" ? "Reclaim" : "Restoring separate copies";
	if (job.status === "running") return RUNNING_LABELS[job.phase];
	if (job.status === "interrupted") return `${name} stopped part way`;
	if (job.status === "failed") return `${name} stopped after repeated errors`;
	if (job.status === "cancelled")
		return job.stopReason === "raw_index_off"
			? "Reclaim stopped because ATTACHMENT_RAW_INDEX is off"
			: `${name} cancelled`;
	return job.direction === "reclaim" ? "Space reclaimed" : "Separate copies restored";
}

/** How far a job is, as a share of the files it counted when it (or its current pass) started. */
export function jobProgress(job: AttachmentStorageJobView): { done: number; total: number; percent: number } {
	const total = Math.max(job.total, job.done);
	return { done: job.done, total, percent: total ? Math.round((job.done / total) * 100) : 100 };
}

/** What the job did, in plain words. */
export function jobSummary(job: AttachmentStorageJobView): string {
	const parts: string[] = [];
	if (job.direction === "reclaim") {
		if (job.converted) parts.push(`${files(job.converted)} now served from the raw message`);
		if (job.unmatched) parts.push(`${files(job.unmatched)} kept a separate copy`);
	} else {
		if (job.converted) parts.push(`${files(job.converted)} copied out of the raw message`);
		if (job.unshared) parts.push(`${files(job.unshared)} no longer shared`);
	}
	if (job.failed) parts.push(`${files(job.failed)} could not be processed`);
	return parts.length ? `${parts.join(", ")}.` : "Nothing needed to change.";
}

/** A direction that resumes an interrupted job instead of starting over. */
export function resumableDirection(job: AttachmentStorageJobView | null): AttachmentStorageJobView["direction"] | null {
	return job?.status === "interrupted" ? job.direction : null;
}

/**
 * What the confirmation adds when copies are restored while new mail would still be shared or served from the raw
 * message, so the counts would not stay at 0 for a rollback. Null when both switches are off.
 */
export function materializeWarning(switches: AttachmentStorageReport["switches"]): string | null {
	const on = [
		...(switches.sharing ? ["ATTACHMENT_SHARING"] : []),
		...(switches.rawIndex ? ["ATTACHMENT_RAW_INDEX"] : []),
	];
	if (!on.length) return null;
	return `${on.join(" and ")} ${on.length === 1 ? "is" : "are"} still on, so new mail, sends and forwards keep sharing copies or being served from the raw message after this. If you are preparing a rollback, set both to off and deploy first.`;
}

export function canReclaim(report: AttachmentStorageReport): boolean {
	return (
		report.jobsReady &&
		report.switches.rawIndex &&
		!isJobRunning(report.job) &&
		((report.reclaim?.pending.rows ?? 0) > 0 || resumableDirection(report.job) === "reclaim")
	);
}

export function canMaterialize(report: AttachmentStorageReport): boolean {
	return (
		report.jobsReady &&
		!isJobRunning(report.job) &&
		(report.raw.rows > 0 || report.shared.rows > 0 || resumableDirection(report.job) === "materialize")
	);
}

/** The four numbers the card shows. */
export function attachmentStorageStats(
	report: AttachmentStorageReport,
): { label: string; value: string; hint: string }[] {
	const pending = report.reclaim?.pending ?? { rows: 0, bytes: 0 };
	return [
		{
			label: "Own copy",
			value: report.objects.rows.toLocaleString(),
			hint: `${formatDriveSize(report.objects.storedBytes)} stored`,
		},
		{
			label: "From the raw message",
			value: report.raw.rows.toLocaleString(),
			hint: `${formatDriveSize(report.raw.bytes)} not stored twice`,
		},
		{
			label: "Shared copies",
			value: report.shared.rows.toLocaleString(),
			hint: report.shared.keys ? `of ${files(report.shared.keys)}` : "None",
		},
		{
			label: "Can be reclaimed",
			value: pending.rows.toLocaleString(),
			hint: report.reclaim ? `up to ${formatDriveSize(pending.bytes)}` : "After the database update",
		},
	];
}
