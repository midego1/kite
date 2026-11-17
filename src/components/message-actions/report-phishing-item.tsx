"use client";

import { ShieldX } from "lucide-react";
import { useT } from "@/lib/i18n/use-t";

/** The "Report phishing" entry of a message's More actions menu; the caller confirms and runs it. */
export function ReportPhishingItem({ onSelect, disabled }: { onSelect: () => void; disabled?: boolean }) {
	const t = useT();
	return (
		<button
			type="button"
			className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent"
			disabled={disabled}
			onClick={onSelect}
		>
			<ShieldX className="h-4 w-4 shrink-0" />
			{t("Report phishing")}
		</button>
	);
}
