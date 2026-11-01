"use client";

import Link from "next/link";
import { ArrowUpRight, Mail, Sparkles, UserCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StatusChip } from "./command-center-types";
import { COMMAND_CENTER_ICON_CLASS } from "./command-center-card";

/** The counts' icons: the sidebar's own for the Screener and For you, an envelope for the folder's unread mail. */
const CHIP_ICON: Record<StatusChip["id"], LucideIcon> = {
	unread: Mail,
	screener: UserCheck,
	"for-you": Sparkles,
};

/**
 * The numbers that matter, as tiles that open their page: the folder's unread mail, what the Screener holds and
 * what For you suggests, sharing the row whatever their number. The number is large; the icon and a small arrow
 * say the tile can be clicked. The unread tile keeps its place while the counts load so the row never jumps.
 */
export function CommandCenterStats({ chips, countsLoading }: { chips: StatusChip[]; countsLoading: boolean }) {
	return (
		<div role="group" aria-label="Right now" className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
			{chips.map((chip) => {
				const Icon = CHIP_ICON[chip.id];
				return (
					<Link
						key={chip.id}
						href={chip.href}
						data-chip={chip.id}
						className={cn(
							"group flex min-w-0 flex-col rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-neutral-900 transition-colors hover:border-neutral-300 hover:bg-neutral-100",
							countsLoading && chip.id === "unread" && "invisible",
						)}
					>
						<span className="flex items-center justify-between">
							<span className={COMMAND_CENTER_ICON_CLASS}>
								<Icon className="h-4 w-4" aria-hidden="true" />
							</span>
							<ArrowUpRight
								className="h-4 w-4 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
								aria-hidden="true"
							/>
						</span>
						<span className="mt-4 block text-3xl font-semibold tracking-tight tabular-nums">{chip.value}</span>{" "}
						<span className="mt-0.5 block truncate text-sm text-neutral-600">{chip.caption}</span>
					</Link>
				);
			})}
		</div>
	);
}
