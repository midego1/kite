"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDatabaseBytes } from "@/lib/db/size-utils";
import {
	type ImportEstimate,
	describeImportEstimate,
	importTotalRows,
	type SourceSizeKind,
} from "@/lib/import/estimate-utils";
import { fetchImportEstimate } from "./import-size-utils";

type Props = {
	/** Messages the import will read when known (a limited import or the ticked folders); null for a whole folder. */
	messages: number | null;
	/** Bytes of source mail for those messages, when the page knows them (measured or estimated). */
	rawBytes?: number | null;
	sizeKind?: SourceSizeKind;
	/** Show the totals whatever the database use; otherwise only the warning from 70%. */
	showTotals?: boolean;
	/** Lines under the totals: sizes still being measured, folders that could not be, duplicates. */
	notes?: string[];
	importAnyway: boolean;
	onImportAnywayChange: (value: boolean) => void;
	/** True while the import cannot start without "Import anyway". */
	onRequiresConfirmation: (required: boolean) => void;
};

const toneClasses = {
	ok: "border border-neutral-200 bg-neutral-50 text-neutral-700",
	warn: "border border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a]",
	critical: "border border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]",
} as const;

/**
 * What the import adds: always the totals (messages, source size, mail storage, database) when `showTotals`, and a
 * warning from 70% of the database limit with "Import anyway" above 90%. The size at the source is exact when the server
 * or a finished measurement gave it, and marked as an estimate while it is still being measured.
 */
export function ImportSizeNotice({
	messages,
	rawBytes = null,
	sizeKind = "unknown",
	showTotals = false,
	notes = [],
	importAnyway,
	onImportAnywayChange,
	onRequiresConfirmation,
}: Props) {
	const [estimate, setEstimate] = useState<ImportEstimate | null>(null);
	const knownBytes = sizeKind === "unknown" ? null : rawBytes;

	useEffect(() => {
		let active = true;
		const timer = window.setTimeout(() => {
			fetchImportEstimate(messages, knownBytes)
				.then((next) => {
					if (!active) return;
					setEstimate(next);
					onRequiresConfirmation(!!next?.requiresConfirmation);
				})
				.catch(() => {
					if (active) onRequiresConfirmation(false);
				});
		}, 300);
		return () => {
			active = false;
			window.clearTimeout(timer);
		};
	}, [messages, knownBytes, onRequiresConfirmation]);

	const level = estimate?.projectedLevel ?? "ok";
	if (!showTotals && (!estimate || level === "ok")) return null;
	const critical = level === "critical";
	const rows = importTotalRows({ messages, rawBytes: knownBytes }, estimate, formatDatabaseBytes, sizeKind);
	return (
		<div
			role={critical ? "alert" : "status"}
			data-testid={level === "ok" ? "import-size-total" : "import-size-notice"}
			className={`space-y-2 rounded-lg px-4 py-3 text-sm ${toneClasses[level]}`}
		>
			{showTotals ? (
				<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" aria-label="Import size">
					{rows.map((row) => (
						<div key={row.key} className="contents" data-total={row.key}>
							<dt className="font-medium">{row.label}</dt>
							<dd className="tabular-nums">{row.value}</dd>
						</div>
					))}
				</dl>
			) : (
				estimate && <p>{describeImportEstimate(estimate, formatDatabaseBytes).summary}</p>
			)}
			{level !== "ok" && (
				<p>
					{critical
						? "That is above 90% of the database size limit."
						: "That is above 70% of the database size limit. Importing still works; consider freeing space first."}
				</p>
			)}
			{critical && (
				<label className="flex items-center gap-2">
					<Checkbox checked={importAnyway} onChange={(event) => onImportAnywayChange(event.target.checked)} />
					Import anyway
				</label>
			)}
			{showTotals &&
				notes.map((note) => (
					<p key={note} className="text-xs leading-5 opacity-80">
						{note}
					</p>
				))}
		</div>
	);
}
