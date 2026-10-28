"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDatabaseBytes } from "@/lib/db/size-utils";
import { type ImportEstimate, describeImportEstimate } from "@/lib/import/estimate-utils";
import { fetchImportEstimate } from "./import-size-utils";

type Props = {
	/** Messages the import will read when known (a limited import); null for a whole folder. */
	messages: number | null;
	importAnyway: boolean;
	onImportAnywayChange: (value: boolean) => void;
	/** True while the import cannot start without "Import anyway". */
	onRequiresConfirmation: (required: boolean) => void;
};

const toneClasses = {
	warn: "border border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a]",
	critical: "border border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]",
} as const;

/** What the import adds to the database, with a warning from 70% of its limit and "Import anyway" above 90%. */
export function ImportSizeNotice({ messages, importAnyway, onImportAnywayChange, onRequiresConfirmation }: Props) {
	const [estimate, setEstimate] = useState<ImportEstimate | null>(null);

	useEffect(() => {
		let active = true;
		const timer = window.setTimeout(() => {
			fetchImportEstimate(messages)
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
	}, [messages, onRequiresConfirmation]);

	if (!estimate || estimate.projectedLevel === "ok") return null;
	const { summary, level } = describeImportEstimate(estimate, formatDatabaseBytes);
	const critical = level === "critical";
	return (
		<div
			role={critical ? "alert" : "status"}
			data-testid="import-size-notice"
			className={`space-y-2 rounded-lg border px-4 py-3 text-sm ${toneClasses[critical ? "critical" : "warn"]}`}
		>
			<p>
				{summary}{" "}
				{critical
					? "That is above 90% of the database size limit."
					: "That is above 70% of the database size limit. Importing still works; consider freeing space first."}
			</p>
			{critical && (
				<label className="flex items-center gap-2">
					<Checkbox checked={importAnyway} onChange={(event) => onImportAnywayChange(event.target.checked)} />
					Import anyway
				</label>
			)}
		</div>
	);
}
