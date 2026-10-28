"use client";

import type { ImportJob, ImportJobFolder } from "@/app/(import)/settings/import/types";
import { List, ListRow } from "@/components/ui/list";
import { describeJobDestination } from "@/app/(import)/settings/import/utils";

const folderStatusLabels: Record<ImportJobFolder["status"], string> = {
	pending: "Waiting",
	running: "Importing",
	completed: "Done",
	skipped: "Not imported",
	failed: "Failed",
};

/** The folders of a whole-account import with their own progress, and why a paused import waits. */
export function ImportJobFolders({ job }: { job: ImportJob }) {
	const pausedByUser = job.status === "paused" && job.pauseReason === "user";
	if (!job.folders.length && !pausedByUser) return null;
	const multiLabel = job.folders.reduce((sum, folder) => sum + folder.multiLabel, 0);
	return (
		<div className="space-y-2">
			{pausedByUser && <p className="text-xs text-neutral-500">Paused. Resume to continue where it stopped.</p>}
			{job.folders.length > 0 && (
				<List role="list" aria-label="Folders" className="text-xs max-md:rounded-xl max-md:border-x">
					{job.folders.map((folder) => (
						<ListRow key={folder.sourceName} role="listitem" className="flex-wrap justify-between gap-2 px-3 py-2">
							<span className="min-w-0 truncate text-neutral-800">
								{folder.sourceName}
								<span className="text-neutral-500"> → {describeJobDestination(folder)}</span>
							</span>
							<span className="text-neutral-500">
								{folder.processed}
								{folder.total !== null ? `/${folder.total}` : ""} · {folder.imported} imported · {folder.skipped}{" "}
								skipped · {folderStatusLabels[folder.status]}
							</span>
							{folder.lastError && <span className="w-full break-all text-red-600">{folder.lastError}</span>}
						</ListRow>
					))}
				</List>
			)}
			{multiLabel > 0 && (
				<p className="text-xs text-neutral-500">
					{multiLabel} message{multiLabel === 1 ? " had" : "s had"} several Gmail labels and went to the folder of the
					first one.
				</p>
			)}
		</div>
	);
}
