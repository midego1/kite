import Link from "next/link";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { SUCCESS_TEXT_CLASS, WARNING_TEXT_CLASS } from "@/components/notice-styles";
import { cn } from "@/lib/utils";
import type { CommandCenterTone } from "./command-center-types";

/**
 * A card of the command center: the muted fill one step up from the pane (the page's own panel fill, so it
 * follows every style and theme), a hairline border and the dialogs' large radius. Its rows and tiles sit on it
 * in the pane's white.
 */
const COMMAND_CENTER_CARD_CLASS = "rounded-2xl border border-neutral-200 bg-neutral-50 p-5";

/**
 * A row of a card, drawn like a sidebar link (components-nav.tsx) or a Settings menu item: 40 px high, an icon or
 * a mark, the text, and whatever sits at the right, with the sidebar's hover fill when it can be clicked.
 */
export const COMMAND_CENTER_ROW_CLASS =
	"flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-2 text-sm text-neutral-700";

/** A row that opens something: the sidebar's hover. */
export const COMMAND_CENTER_LINK_ROW_CLASS = `${COMMAND_CENTER_ROW_CLASS} transition-colors hover:bg-neutral-200/60 hover:text-neutral-900`;

/** The rows of a card, one under the other with a hairline between them. */
export const COMMAND_CENTER_LIST_CLASS = "divide-y divide-neutral-200/70";

/**
 * A quick-action tile: the sidebar's bordered "New email" button (components-nav.tsx), raised a little on the
 * card's fill, with an icon circle, the label and, at the right, the key that does the same.
 */
export const COMMAND_CENTER_TILE_CLASS =
	"flex min-w-0 items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-medium text-neutral-900 shadow-2xs transition-colors hover:border-neutral-300 hover:bg-neutral-100";

/** The detail at the right of a row: muted and small, like the counts in the sidebar. */
export const COMMAND_CENTER_DETAIL_CLASS = "ml-auto shrink-0 text-xs text-neutral-500";

/** A text link in a card's header or under its rows: small, in the style's accent, underlined on hover. */
export const COMMAND_CENTER_LINK_CLASS =
	"text-xs font-medium text-blue-600 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none";

/**
 * The icon circle of a tile or a card title: the accent's faintest tint with the accent itself, as each style
 * remaps them (grey and near-black in Kite, lavender in Kite classic, blue in Classic).
 */
export const COMMAND_CENTER_ICON_CLASS =
	"flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600";

/** The mark before a row that says how something is doing: green when fine, amber when it needs someone, grey when off. */
export const COMMAND_CENTER_MARK_CLASS: Record<CommandCenterTone, string> = {
	ok: SUCCESS_TEXT_CLASS,
	warn: WARNING_TEXT_CLASS,
	muted: "text-neutral-400",
};

const PILL_CLASS: Record<CommandCenterTone, string> = {
	ok: `bg-[#22c55e]/12 ${SUCCESS_TEXT_CLASS}`,
	warn: `bg-[#f59e0b]/14 ${WARNING_TEXT_CLASS}`,
	muted: "bg-neutral-200/70 text-neutral-600",
};

/** A small status pill at the right of a row: "Synced 3 min ago", "Healthy", "Paused". */
export function CommandCenterPill({
	tone,
	children,
	className,
}: {
	tone: CommandCenterTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
				PILL_CLASS[tone],
				className,
			)}
			data-tone={tone}
		>
			{children}
		</span>
	);
}

/**
 * A card with nothing to list: a quiet glyph, one line saying so, and where to go instead ("Nothing today",
 * Open calendar).
 */
export function CommandCenterEmpty({
	icon: Icon,
	children,
	action,
}: {
	icon: LucideIcon;
	children: ReactNode;
	action?: { label: string; href: string };
}) {
	return (
		<div className="flex flex-col items-center gap-2 px-3 py-4 text-center" data-command-center-empty>
			<span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-neutral-500 ring-1 ring-neutral-200">
				<Icon className="h-5 w-5" aria-hidden="true" />
			</span>
			<p className="text-sm text-neutral-700">{children}</p>
			{action && (
				<Link href={action.href} className={COMMAND_CENTER_LINK_CLASS}>
					{action.label}
				</Link>
			)}
		</div>
	);
}

/**
 * One card of the command center (and of the cards modules add through `reading-pane` slots): a title with its
 * icon, an optional link at the right, then its rows.
 */
export function CommandCenterCard({
	title,
	icon: Icon,
	action,
	children,
	testId,
	className,
}: {
	title: string;
	icon?: LucideIcon;
	action?: { label: string; href: string };
	children: ReactNode;
	testId?: string;
	className?: string;
}) {
	return (
		<section aria-label={title} data-testid={testId} className={cn(COMMAND_CENTER_CARD_CLASS, className)}>
			<div className="mb-3 flex min-h-8 items-center gap-2.5">
				{Icon && (
					<span className={cn(COMMAND_CENTER_ICON_CLASS, "h-7 w-7 rounded-lg")}>
						<Icon className="h-4 w-4" aria-hidden="true" />
					</span>
				)}
				<h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">{title}</h3>
				{action && (
					<Link href={action.href} className={COMMAND_CENTER_LINK_CLASS}>
						{action.label}
					</Link>
				)}
			</div>
			{children}
		</section>
	);
}
