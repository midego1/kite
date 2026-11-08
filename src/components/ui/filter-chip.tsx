"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A chip over a list that narrows it (the mail list's Primary, Unread, Attachments and Starred; Drive's Photos,
 * Videos, Documents and Others): 32 px high, the muted fill when idle and, when it is on, the sidebar's active
 * row (the accent's lightest tint, as every style remaps it) instead of a solid accent.
 */
const FILTER_CHIP_CLASS =
	"inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 pointer-coarse:h-11";
const FILTER_CHIP_ON_CLASS = "bg-blue-100 text-blue-900";
const FILTER_CHIP_OFF_CLASS = "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900";

type FilterChipProps = {
	/** Whether the chip is on; buttons report it as `aria-pressed`, links as `aria-current`. */
	active: boolean;
	icon?: LucideIcon;
	/** Fills the icon's glyph while the chip is on (the lightning of "Primary"). */
	fillIcon?: boolean;
	/** The chip's name; shown unless `iconOnly`, and always its accessible name. */
	label: string;
	/** Draws only the icon, as a 32 px square. */
	iconOnly?: boolean;
	/** A link to another page instead of a toggle. */
	href?: string;
	className?: string;
} & Omit<ComponentProps<"button">, "aria-pressed" | "children" | "className">;

export function FilterChip({
	active,
	icon: Icon,
	fillIcon,
	label,
	iconOnly,
	href,
	className,
	...props
}: FilterChipProps) {
	const classes = cn(
		FILTER_CHIP_CLASS,
		active ? FILTER_CHIP_ON_CLASS : FILTER_CHIP_OFF_CLASS,
		iconOnly ? "w-8 pointer-coarse:w-11" : "px-3",
		className,
	);
	const content: ReactNode = (
		<>
			{Icon && (
				<Icon className="h-4 w-4 shrink-0" fill={active && fillIcon ? "currentColor" : "none"} aria-hidden="true" />
			)}
			{!iconOnly && <span className="truncate">{label}</span>}
		</>
	);
	if (href)
		return (
			<Link href={href} aria-label={label} aria-current={active ? "page" : undefined} className={classes}>
				{content}
			</Link>
		);
	return (
		<button type="button" aria-label={label} aria-pressed={active} className={classes} {...props}>
			{content}
		</button>
	);
}
