"use client";

import clsx from "clsx";
import { CalendarDays, CircleCheck, Receipt, Reply, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { pickSuggestionBadge } from "@/lib/agent/auto-read/suggestion-badge-utils";
import type { SuggestionCount, SuggestionKind } from "@/lib/agent/auto-read/suggestion-types";

const CHIPS: Partial<Record<SuggestionKind, { label: string; icon: LucideIcon; className: string }>> = {
	phishing: {
		label: "Phishing",
		icon: ShieldAlert,
		className: "border-red-200 bg-red-50 text-red-700",
	},
	calendar_invite: { label: "Invite", icon: CalendarDays, className: "border-blue-200 bg-blue-50 text-blue-700" },
	reply: { label: "Reply", icon: Reply, className: "border-blue-200 bg-blue-50 text-blue-700" },
	task: { label: "Task", icon: CircleCheck, className: "border-blue-200 bg-blue-50 text-blue-700" },
	receipt: { label: "Receipt", icon: Receipt, className: "border-neutral-200 bg-neutral-50 text-neutral-600" },
};

/** One chip for the row's most important open Kite suggestion, plus "+n" for the others. */
export function SuggestionBadge({ suggestions }: { suggestions?: SuggestionCount[] }) {
	const badge = pickSuggestionBadge(suggestions ?? []);
	const chip = badge && CHIPS[badge.kind];
	if (!badge || !chip) return null;
	const Icon = chip.icon;
	const label = `Kite suggestion: ${chip.label}${badge.more > 0 ? `, ${badge.more} more` : ""}`;
	return (
		<span
			data-suggestion-badge={badge.kind}
			aria-label={label}
			title={label}
			className={clsx(
				"ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px align-middle text-[11px] font-medium leading-4",
				chip.className,
			)}
		>
			<Icon aria-hidden className="h-3 w-3" />
			<span aria-hidden>{chip.label}</span>
			{badge.more > 0 && <span aria-hidden>+{badge.more}</span>}
		</span>
	);
}
