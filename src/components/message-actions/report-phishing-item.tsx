"use client";

import { ShieldX } from "lucide-react";

/** The "Report phishing" entry of a message's More actions menu; the caller confirms and runs it. */
export function ReportPhishingItem({ onSelect }: { onSelect: () => void }) {
	return (
		<button
			type="button"
			className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
			onClick={onSelect}
		>
			<ShieldX className="h-4 w-4 shrink-0" />
			Report phishing
		</button>
	);
}
