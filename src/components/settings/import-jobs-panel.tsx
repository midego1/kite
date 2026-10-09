"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ImportJob } from "@/app/(settings)/settings/import/types";
import {
	cancelImportJob,
	fetchImportJobs,
	getImportJobPercent,
	isActiveImportJob,
} from "@/app/(settings)/settings/import/utils";

const POLL_INTERVAL_MS = 3000;

const statusStyles: Record<ImportJob["status"], string> = {
	pending: "bg-neutral-100 text-neutral-600",
	running: "bg-blue-50 text-blue-700",
	completed: "bg-green-50 text-green-700",
	failed: "bg-red-50 text-red-700",
	cancelled: "bg-neutral-100 text-neutral-500",
};

const statusLabels: Record<ImportJob["status"], string> = {
	pending: "Waiting",
	running: "Importing",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

function formatRate(job: ImportJob): string | null {
	if (job.status !== "running" || !job.startedAt || !job.total) return null;
	const elapsedMinutes = (Date.now() - new Date(job.startedAt).getTime()) / 60_000;
	if (elapsedMinutes <= 0 || job.processed === 0) return null;
	const perMinute = job.processed / elapsedMinutes;
	const remainingMinutes = Math.max(job.total - job.processed, 0) / perMinute;
	const eta =
		remainingMinutes < 1
			? "under a minute"
			: remainingMinutes < 90
				? `~${Math.round(remainingMinutes)} min`
				: `~${(remainingMinutes / 60).toFixed(1)} h`;
	return `${Math.round(perMinute)} msg/min · ${eta} left`;
}

/**
 * Background IMAP imports for the current user. Imports run on the server
 * through the queue, so this only displays progress and can cancel.
 */
export function ImportJobsPanel({ refreshKey }: { refreshKey: number }) {
	const [jobs, setJobs] = useState<ImportJob[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState<string | null>(null);
	const importedRef = useRef<number | null>(null);

	const load = useCallback(async () => {
		try {
			const next = await fetchImportJobs();
			setJobs(next);
			setError(null);
			// Let mailbox lists and counters refresh when new messages landed.
			const imported = next.reduce((sum, job) => sum + job.imported, 0);
			if (importedRef.current !== null && imported !== importedRef.current) {
				window.dispatchEvent(new Event("kite:messages-changed"));
			}
			importedRef.current = imported;
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : "Unable to load imports");
		}
	}, []);

	useEffect(() => {
		const timer = window.setTimeout(() => void load(), 0);
		return () => window.clearTimeout(timer);
	}, [load, refreshKey]);

	const hasActive = jobs.some(isActiveImportJob);
	useEffect(() => {
		if (!hasActive) return;
		const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [hasActive, load]);

	async function onCancel(id: string) {
		setCancelling(id);
		try {
			await cancelImportJob(id);
			await load();
		} catch (cancelError) {
			setError(cancelError instanceof Error ? cancelError.message : "Unable to cancel import");
		} finally {
			setCancelling(null);
		}
	}

	if (jobs.length === 0 && !error) return null;

	return (
		<section className="space-y-4">
			<div>
				<h2 className="text-xl font-semibold text-neutral-900">Imports</h2>
				<p className="mt-1 text-sm text-neutral-500">
					IMAP imports run in the background on the server. You can leave this page or close the browser; progress
					continues.
				</p>
			</div>
			<div className="space-y-3 rounded-3xl bg-white p-6">
				{error && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
				{jobs.map((job) => {
					const percent = getImportJobPercent(job);
					const rate = formatRate(job);
					return (
						<div key={job.id} className="space-y-2 rounded-xl border border-neutral-100 p-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-neutral-900">
										{job.label}
										<span className="ml-2 text-xs font-normal text-neutral-400">
											{job.folder} · {job.username}
										</span>
									</p>
									<p className="text-xs text-neutral-500">
										{job.processed}
										{job.total !== null ? `/${job.total}` : ""} processed · {job.imported} imported · {job.skipped}{" "}
										skipped
										{rate ? ` · ${rate}` : ""}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusStyles[job.status]}`}>
										{statusLabels[job.status]}
									</span>
									{isActiveImportJob(job) && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={cancelling === job.id}
											onClick={() => void onCancel(job.id)}
										>
											Cancel
										</Button>
									)}
								</div>
							</div>
							<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
								<div
									className={`h-full transition-[width] ${job.status === "failed" ? "bg-red-500" : job.status === "completed" ? "bg-green-500" : "bg-blue-600"}`}
									style={{ width: `${percent}%` }}
								/>
							</div>
							{job.lastError && <p className="text-xs text-red-600">{job.lastError}</p>}
							{job.errors.length > 0 && (
								<details className="text-xs text-neutral-500">
									<summary className="cursor-pointer">
										{job.errors.length} message error
										{job.errors.length === 1 ? "" : "s"}
									</summary>
									<ul className="mt-1 space-y-0.5">
										{job.errors.map((item, index) => (
											<li key={index} className="break-all">
												{item}
											</li>
										))}
									</ul>
								</details>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
