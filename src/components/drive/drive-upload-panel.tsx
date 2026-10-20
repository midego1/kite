"use client";

import clsx from "clsx";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { DriveUploadEntry } from "./drive-types";

const isActive = (entry: DriveUploadEntry) => entry.status === "queued" || entry.status === "uploading";

function UploadRow({ entry, onCancel }: { entry: DriveUploadEntry; onCancel: (id: string) => void }) {
	const finished = entry.status === "failed" || entry.status === "cancelled";
	return (
		<li className="px-4 py-2.5 text-sm" data-drive-upload={entry.status}>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-neutral-900" title={entry.name}>
					{entry.name}
				</span>
				{entry.status === "done" && (
					<CheckCircle2 size={16} className="shrink-0 text-green-600" aria-label="Uploaded" />
				)}
				{entry.status === "failed" && <AlertCircle size={16} className="shrink-0 text-red-600" aria-hidden="true" />}
				{isActive(entry) && (
					<button
						type="button"
						onClick={() => onCancel(entry.id)}
						aria-label={`Cancel ${entry.name}`}
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
					>
						<X size={14} />
					</button>
				)}
			</div>
			{finished ? (
				<p className={clsx("mt-1 text-xs", entry.status === "failed" ? "text-red-600" : "text-neutral-500")}>
					{entry.status === "failed" ? (entry.error ?? "Upload failed") : "Cancelled"}
				</p>
			) : (
				<div className="mt-1.5 flex items-center gap-3">
					<div
						role="progressbar"
						aria-label={entry.name}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={entry.percent}
						className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200"
					>
						<div
							className={clsx(
								"h-full rounded-full transition-[width] duration-200",
								entry.status === "done" ? "bg-green-600" : "bg-blue-600",
							)}
							style={{ width: `${entry.percent}%` }}
						/>
					</div>
					<span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-600">
						{entry.status === "queued" ? "-" : `${entry.percent}%`}
					</span>
				</div>
			)}
			{entry.resumed && entry.status === "uploading" && (
				<p className="mt-1 text-xs text-neutral-500">Resuming an earlier upload</p>
			)}
		</li>
	);
}

/** Every upload of the visit stacked in one card: a row per file with its bar, Cancel and any error. */
export function DriveUploadPanel({
	uploads,
	onCancel,
	onClose,
}: {
	uploads: DriveUploadEntry[];
	onCancel: (id: string) => void;
	onClose: () => void;
}) {
	if (!uploads.length) return null;
	const active = uploads.filter(isActive).length;
	const done = uploads.filter((entry) => entry.status === "done").length;

	return (
		<section
			aria-label="Uploads"
			className="fixed bottom-4 right-4 z-[90] w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl"
		>
			<header className="flex items-center justify-between gap-3 bg-neutral-50 px-4 py-2.5 text-sm font-medium text-neutral-800">
				<span aria-live="polite">
					{active ? `Uploading ${active} ${active === 1 ? "file" : "files"}` : `${done} uploaded`}
				</span>
				<button
					type="button"
					onClick={onClose}
					disabled={active > 0}
					aria-label="Close uploads"
					className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200 disabled:invisible"
				>
					<X size={16} />
				</button>
			</header>
			<ul className="max-h-64 divide-y divide-neutral-100 overflow-y-auto">
				{uploads.map((entry) => (
					<UploadRow key={entry.id} entry={entry} onCancel={onCancel} />
				))}
			</ul>
		</section>
	);
}
