"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, HardDrive } from "lucide-react";
import { ERROR_TEXT_CLASS, WARNING_TEXT_CLASS } from "@/components/notice-styles";
import { Card, CardContent, CardTitleRow } from "@/components/ui/card";
import { type DatabaseUseLevel, formatDatabaseBytes } from "@/lib/db/size-utils";
import { DATABASE_SIZE_QUERY, fetchDatabaseSize } from "./admin-database-size-query";

const tones: Record<DatabaseUseLevel, { icon: "neutral" | "warning" | "critical"; bar: string; text: string }> = {
	ok: { icon: "neutral", bar: "bg-blue-500", text: "text-neutral-500" },
	warn: { icon: "warning", bar: "bg-amber-500", text: WARNING_TEXT_CLASS },
	critical: { icon: "critical", bar: "bg-red-600", text: ERROR_TEXT_CLASS },
};

/** The database against its size limit; amber from 70% and red from 90%, when imports also stop (docs/operations.md). */
export function AdminDatabaseSizeCard() {
	// The overview's tiles read the same query, so the page asks the server once.
	const { data } = useQuery({ queryKey: DATABASE_SIZE_QUERY, queryFn: fetchDatabaseSize, retry: false });

	if (!data?.size) return null;
	const { size, level } = data;
	const tone = tones[level];
	const percent = size.limitBytes ? Math.min(100, Math.round((size.usedBytes / size.limitBytes) * 100)) : null;
	return (
		<Card data-testid="database-size-card" data-level={level}>
			<CardTitleRow
				icon={level === "ok" ? HardDrive : AlertTriangle}
				tone={tone.icon}
				title="Database size"
				description={
					<span className={tone.text}>
						{formatDatabaseBytes(size.usedBytes)}
						{size.limitBytes
							? ` of ${formatDatabaseBytes(size.limitBytes)} (${percent}%)`
							: " (no size limit on this server)"}
					</span>
				}
			/>
			{size.limitBytes && (
				<CardContent className="space-y-3 pt-4">
					<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100" aria-hidden>
						<div className={`h-full ${tone.bar}`} style={{ width: `${percent}%` }} />
					</div>
					{level !== "ok" && (
						<p role={level === "critical" ? "alert" : "status"} className={`text-sm ${tone.text}`}>
							{level === "critical"
								? "The database is above 90% of its size limit. Running imports pause and new ones ask for confirmation. Delete mail you do not need, or move to a plan with a larger limit."
								: "The database is above 70% of its size limit. Large imports will warn before they start."}{" "}
							Running on Workers Free? Set <code>D1_MAX_BYTES=500000000</code> so this card uses its 500 MB limit.
						</p>
					)}
				</CardContent>
			)}
		</Card>
	);
}
