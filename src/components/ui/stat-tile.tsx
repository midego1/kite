import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CARD_CLASS } from "./page-utils";

const tones = {
	neutral: "text-neutral-900",
	warning: "text-[#8a4b0a] dark:text-[#d4a35a]",
	critical: "text-[#b91c1c] dark:text-[#f19999]",
} as const;

/** A headline number with its label and a line under it; linked when it opens the page behind the number. */
export function StatTile({
	label,
	value,
	hint,
	icon: Icon,
	tone = "neutral",
	href,
	className,
	...props
}: {
	label: ReactNode;
	value: ReactNode;
	hint?: ReactNode;
	icon?: LucideIcon;
	tone?: keyof typeof tones;
	href?: string;
	className?: string;
	"data-testid"?: string;
}) {
	const body = (
		<>
			<p className="flex items-center gap-1.5 text-sm text-neutral-500">
				{Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
				{label}
			</p>
			<p className={cn("mt-1.5 text-2xl font-semibold tabular-nums", tones[tone])}>{value}</p>
			{hint && <p className="mt-0.5 truncate text-xs text-neutral-500">{hint}</p>}
		</>
	);
	const classes = cn(CARD_CLASS, "block min-w-0 p-4", href && "transition-colors hover:bg-neutral-50", className);
	return href ? (
		<Link href={href} className={classes} {...props}>
			{body}
		</Link>
	) : (
		<div className={classes} {...props}>
			{body}
		</div>
	);
}

/** Tiles in a row: two on a phone, up to four from `lg`. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}
