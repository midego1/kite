"use client";

import clsx from "clsx";
import { Columns2, List, Rows2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MESSAGE_DENSITY_OPTIONS, READING_PANE_OPTIONS } from "@/components/messages/reading-layout-utils";
import { useMessageListDensity, useReadingPaneMode } from "@/components/messages/use-reading-layout";
import { saveMessageListVisible } from "@/components/messages/message-list-visibility-utils";
import type { ReadingPaneMode } from "@/components/messages/reading-layout-types";
import type { ReadingLayoutSegmentProps } from "./reading-layout-menu-types";

const READING_PANE_ICONS: Record<ReadingPaneMode, LucideIcon> = { none: List, right: Columns2, below: Rows2 };

function SegmentButton({ checked, label, description, onSelect, children }: ReadingLayoutSegmentProps) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			aria-label={label}
			title={description}
			onClick={onSelect}
			className={clsx(
				"flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
				checked ? "bg-white text-blue-700 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
			)}
		>
			{children}
		</button>
	);
}

/** Quick reading-pane and density switches for the account menu; changes apply to every open list at once. */
export function ReadingLayoutMenu() {
	const [readingPane, setReadingPane] = useReadingPaneMode();
	const [density, setDensity] = useMessageListDensity();

	return (
		<div className="mt-3 space-y-3 border-t border-neutral-100 px-3 pt-3">
			<div>
				<p
					id="reading-pane-menu-label"
					className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500"
				>
					Reading pane
				</p>
				<div
					role="radiogroup"
					aria-labelledby="reading-pane-menu-label"
					className="flex gap-1 rounded-xl bg-neutral-100 p-1"
				>
					{READING_PANE_OPTIONS.map((option) => {
						const Icon = READING_PANE_ICONS[option.value];
						return (
							<SegmentButton
								key={option.value}
								checked={readingPane === option.value}
								label={option.label}
								description={option.description}
								onSelect={() => {
									if (option.value !== "none") saveMessageListVisible(true);
									setReadingPane(option.value);
								}}
							>
								<Icon size={16} aria-hidden />
								<span className="truncate">{option.label}</span>
							</SegmentButton>
						);
					})}
				</div>
			</div>
			<div>
				<p id="density-menu-label" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
					Density
				</p>
				<div
					role="radiogroup"
					aria-labelledby="density-menu-label"
					className="flex gap-1 rounded-xl bg-neutral-100 p-1"
				>
					{MESSAGE_DENSITY_OPTIONS.map((option) => (
						<SegmentButton
							key={option.value}
							checked={density === option.value}
							label={option.label}
							description={option.description}
							onSelect={() => setDensity(option.value)}
						>
							<span className="truncate">{option.label}</span>
						</SegmentButton>
					))}
				</div>
			</div>
		</div>
	);
}
