"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Notice } from "@/components/ui/notice";
import { authFetch } from "@/lib/auth/client";
import type { AttachmentStorageJobView } from "@/lib/email/attachment-storage-jobs-types";
import type { AttachmentStorageAction, AttachmentStorageReport } from "./attachment-storage-types";
import {
	ATTACHMENT_ROLLBACK_URL,
	ATTACHMENT_STORAGE_QUERY_KEY,
	attachmentStorageStats,
	canMaterialize,
	canReclaim,
	isJobRunning,
	jobHeadline,
	jobProgress,
	jobSummary,
	resumableDirection,
} from "./attachment-storage-utils";

async function fetchReport(): Promise<AttachmentStorageReport> {
	const response = await authFetch("/api/admin/attachment-storage");
	if (!response.ok) throw new Error(`Could not load attachment storage (${response.status})`);
	return (await response.json()) as AttachmentStorageReport;
}

async function postAction(action: AttachmentStorageAction): Promise<void> {
	const response = await authFetch("/api/admin/attachment-storage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action }),
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Request failed (${response.status})`);
	}
}

function JobStatus({ job }: { job: AttachmentStorageJobView }) {
	const running = isJobRunning(job);
	const progress = jobProgress(job);
	return (
		<div data-testid="attachment-storage-job" data-status={job.status} className="space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p role="status" className="font-medium text-neutral-900">
					{jobHeadline(job)}
				</p>
				<p className="text-sm text-neutral-500">
					{progress.done.toLocaleString()} of {progress.total.toLocaleString()} files
				</p>
			</div>
			{running && (
				<div
					role="progressbar"
					aria-label="Attachment storage progress"
					aria-valuemin={0}
					aria-valuemax={progress.total}
					aria-valuenow={progress.done}
					className="h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
				>
					<div
						className="h-full rounded-full bg-blue-600 transition-[width] dark:bg-blue-400"
						style={{ width: `${progress.percent}%` }}
					/>
				</div>
			)}
			<p className="text-sm text-neutral-500">{jobSummary(job)}</p>
			{job.lastError && <p className="text-sm text-red-600">{job.lastError}</p>}
		</div>
	);
}

function Actions({
	report,
	busy,
	onAction,
}: {
	report: AttachmentStorageReport;
	busy: boolean;
	onAction: (action: AttachmentStorageAction) => void;
}) {
	const resume = resumableDirection(report.job);
	async function materialize() {
		const confirmed = await requestConfirmation({
			title: "Restore separate copies?",
			description:
				"Kite writes a copy of every file it now serves from its raw message, and gives every file that shares a copy with a forward or a sent message its own. Do this before running an older release; it uses more storage until you reclaim again.",
			confirmLabel: resume === "materialize" ? "Resume" : "Restore copies",
		});
		if (confirmed) onAction("materialize");
	}
	async function reclaim() {
		const confirmed = await requestConfirmation({
			title: "Reclaim space?",
			description:
				"Kite checks each received or imported file against its raw message. Files whose bytes match are served from the message and their separate copy is deleted; copies that a forward or a sent message still uses are kept.",
			confirmLabel: resume === "reclaim" ? "Resume" : "Reclaim space",
		});
		if (confirmed) onAction("reclaim");
	}
	return (
		<div className="flex flex-wrap gap-2">
			{isJobRunning(report.job) ? (
				<Button size="sm" variant="outline" disabled={busy} onClick={() => onAction("cancel")}>
					Stop
				</Button>
			) : (
				<>
					<Button size="sm" disabled={busy || !canReclaim(report)} onClick={() => void reclaim()}>
						{resume === "reclaim" ? "Resume reclaim" : "Reclaim space"}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !canMaterialize(report)}
						onClick={() => void materialize()}
					>
						{resume === "materialize" ? "Resume restoring copies" : "Restore separate copies"}
					</Button>
				</>
			)}
		</div>
	);
}

function CardBody({ report, onChanged }: { report: AttachmentStorageReport; onChanged: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function act(action: AttachmentStorageAction) {
		setBusy(true);
		setError(null);
		try {
			await postAction(action);
			onChanged();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not update attachment storage");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="mt-4 space-y-4">
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{attachmentStorageStats(report).map((stat) => (
					<div key={stat.label} className="rounded-lg border border-neutral-200 p-3">
						<dt className="text-xs text-neutral-500">{stat.label}</dt>
						<dd className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{stat.value}</dd>
						<dd className="text-xs text-neutral-500">{stat.hint}</dd>
					</div>
				))}
			</dl>
			{!report.jobsReady && <Notice>Apply the pending database update to reclaim space or restore copies.</Notice>}
			{report.jobsReady && !report.switches.rawIndex && (
				<Notice>Reclaim is off while ATTACHMENT_RAW_INDEX is off. Restoring separate copies still works.</Notice>
			)}
			{report.job && <JobStatus job={report.job} />}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			<Actions report={report} busy={busy} onAction={(action) => void act(action)} />
			<p className="text-xs text-neutral-500">
				Before running an older release, set ATTACHMENT_SHARING=off and ATTACHMENT_RAW_INDEX=off, deploy, then restore
				separate copies.{" "}
				<a
					href={ATTACHMENT_ROLLBACK_URL}
					target="_blank"
					rel="noreferrer"
					className="text-blue-700 underline underline-offset-2 dark:text-blue-300"
				>
					Rollback steps
				</a>
			</p>
		</div>
	);
}

/** Admin → Storage: how attachments are stored, and the reclaim and materialize jobs (`docs/specs/attachments-once.md`). */
export function AttachmentStorageCard() {
	const queryClient = useQueryClient();
	const report = useQuery({
		queryKey: ATTACHMENT_STORAGE_QUERY_KEY,
		queryFn: fetchReport,
		refetchInterval: (query) => (isJobRunning(query.state.data?.job ?? null) ? 2000 : false),
	});
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ATTACHMENT_STORAGE_QUERY_KEY });
	return (
		<section
			aria-labelledby="storage-attachments"
			data-testid="attachment-storage-card"
			className="rounded-xl border border-neutral-200 bg-white p-5"
		>
			<h2 id="storage-attachments" className="text-lg font-semibold text-neutral-900">
				Attachment storage
			</h2>
			<p className="mt-1 text-sm text-neutral-500">
				Files in received and imported mail can be served straight from the stored message, so they are not kept twice.
			</p>
			{report.isError && (
				<Notice tone="error" className="mt-4">
					{report.error instanceof Error ? report.error.message : "Could not load attachment storage"}
				</Notice>
			)}
			{report.data && <CardBody report={report.data} onChanged={refresh} />}
		</section>
	);
}
