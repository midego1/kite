"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, HardDrive } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type DatabaseUseLevel, formatDatabaseBytes } from "@/lib/db/size-utils";
import { DATABASE_SIZE_QUERY, fetchDatabaseSize } from "./admin-database-size-query";

const tones: Record<DatabaseUseLevel, { icon: string; bar: string; text: string }> = {
	ok: { icon: "border-neutral-200 bg-[#f6f8fc] text-neutral-600", bar: "bg-blue-500", text: "text-neutral-500" },
	warn: {
		icon: "border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a]",
		bar: "bg-amber-500",
		text: "text-[#8a4b0a] dark:text-[#d4a35a]",
	},
	critical: {
		icon: "border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]",
		bar: "bg-red-600",
		text: "text-[#b91c1c] dark:text-[#f19999]",
	},
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
			<CardHeader className="flex-row items-center gap-4 space-y-0">
				<div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${tone.icon}`}>
					{level === "ok" ? <HardDrive className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
				</div>
				<div>
					<CardTitle className="text-base">Database size</CardTitle>
					<p className={`mt-1 text-sm ${tone.text}`}>
						{formatDatabaseBytes(size.usedBytes)}
						{size.limitBytes
							? ` of ${formatDatabaseBytes(size.limitBytes)} (${percent}%)`
							: " (no size limit on this server)"}
					</p>
				</div>
			</CardHeader>
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
