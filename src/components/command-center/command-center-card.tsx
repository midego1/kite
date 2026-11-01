import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A row of the command center, drawn like a sidebar link (components-nav.tsx) or a Settings menu item: 36 px high,
 * an icon or dot, the text, and whatever sits at the right, with the sidebar's hover fill when it can be clicked.
 */
export const COMMAND_CENTER_ROW_CLASS = "flex h-9 min-w-0 items-center gap-3 rounded-lg px-3 text-sm text-neutral-700";

/** A row that opens something: the sidebar's hover. */
export const COMMAND_CENTER_LINK_ROW_CLASS = `${COMMAND_CENTER_ROW_CLASS} transition-colors hover:bg-neutral-200/60 hover:text-neutral-900`;

/**
 * A quick-action tile: the sidebar's bordered "New email" button (components-nav.tsx) — same height, radius, border,
 * fill, hover and type — with room at the right for the key that does the same.
 */
export const COMMAND_CENTER_TILE_CLASS =
	"flex h-9 min-w-0 items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-100 px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-200";

/** The detail at the right of a row: muted and small, like the counts in the sidebar. */
export const COMMAND_CENTER_DETAIL_CLASS = "ml-auto shrink-0 text-xs text-neutral-500";

/** A text link in a section's header: the muted small type of the section labels, darker on hover. */
export const COMMAND_CENTER_LINK_CLASS =
	"text-xs font-medium text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline";

/**
 * One section of the command center (and of the cards modules add through `reading-pane` slots): the sidebar's
 * small muted group label ("Core", "Folders"), an optional link at the right, then its rows. No border or fill of
 * its own: it sits on the reading pane like the menu sits in the sidebar.
 */
export function CommandCenterCard({
	title,
	action,
	children,
	testId,
}: {
	title: string;
	action?: { label: string; href: string };
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section aria-label={title} data-testid={testId}>
			<div className="flex h-7 items-center justify-between gap-3 px-3">
				<h3 className="text-xs font-medium text-neutral-500">{title}</h3>
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
