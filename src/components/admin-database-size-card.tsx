"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, HardDrive } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type DatabaseSize, type DatabaseUseLevel, formatDatabaseBytes } from "@/lib/db/size-utils";

type SizeResponse = { size: DatabaseSize | null; level: DatabaseUseLevel };

const tones: Record<DatabaseUseLevel, { icon: string; bar: string; text: string }> = {
	ok: { icon: "bg-blue-100 text-blue-700", bar: "bg-blue-600", text: "text-neutral-500" },
	warn: { icon: "bg-amber-100 text-amber-700", bar: "bg-amber-500", text: "text-amber-800" },
	critical: { icon: "bg-red-100 text-red-700", bar: "bg-red-600", text: "text-red-700" },
};

/** The database against its size limit; amber from 70% and red from 90%, when imports also stop (docs/operations.md). */
export function AdminDatabaseSizeCard() {
	const [data, setData] = useState<SizeResponse | null>(null);

	useEffect(() => {
		let active = true;
		fetch("/api/admin/database-size", { cache: "no-store" })
			.then((response) => (response.ok ? (response.json() as Promise<SizeResponse>) : null))
			.then((next) => {
				if (active) setData(next);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);

	if (!data?.size) return null;
	const { size, level } = data;
	const tone = tones[level];
	const percent = size.limitBytes ? Math.min(100, Math.round((size.usedBytes / size.limitBytes) * 100)) : null;
	return (
		<Card className="rounded-3xl border-0 bg-white p-6" data-testid="database-size-card" data-level={level}>
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className={`flex h-10 w-10 items-center justify-center rounded-full ${tone.icon}`}>
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
				<CardContent className="space-y-3 pt-5">
					<div className="h-2 overflow-hidden rounded-full bg-neutral-100" aria-hidden>
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
