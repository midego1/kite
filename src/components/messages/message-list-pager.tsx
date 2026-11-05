"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { ListSection } from "./message-list-sections-utils";
import type { MessageListPagerState } from "./message-list-pager-types";

/**
 * "1 - 25 of 308" and the previous/next arrows. It shares a row with the first section label (or stands alone
 * in a slim row when the list has none), so it is as small as a label row: 28 px arrows, never shrunk.
 */
function ListPager({ pager }: { pager: MessageListPagerState }) {
	return (
		<div className="flex shrink-0 items-center gap-0.5 text-neutral-500">
			<span className="whitespace-nowrap px-1 text-xs text-neutral-500">
				{pager.range.start} - {pager.range.end} of {pager.range.total}
			</span>
			<Tooltip label="Previous page">
				<Button
					variant="ghost"
					size="sm"
					disabled={!pager.canPrevious}
					onClick={pager.previous}
					aria-label="Previous page"
					className="h-7 w-7 p-0"
				>
					<ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
				</Button>
			</Tooltip>
			<Tooltip label="Next page">
				<Button
					variant="ghost"
					size="sm"
					disabled={!pager.canNext}
					onClick={pager.next}
					aria-label="Next page"
					className="h-7 w-7 p-0"
				>
					<ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
				</Button>
			</Tooltip>
		</div>
	);
}

const PAGER_BOX = "flex items-center bg-white px-5 text-sm text-neutral-500";

/** No section label to share a row with: a slim row that stays at the top while the list scrolls. */
export function ListPagerRow({ pager }: { pager: MessageListPagerState }) {
	return (
		<div role="listitem" className={clsx(PAGER_BOX, "sticky top-0 z-20 h-8 justify-end")}>
			<ListPager pager={pager} />
		</div>
	);
}

/** Decorative: the rows carry everything, and a list may only hold list items. */
export function ListSectionLabel({ section, withPager }: { section: ListSection; withPager: boolean }) {
	if (!section.label) return null;
	return (
		<div
			role="presentation"
			className={
				withPager
					? // Room for the pager that floats over the end of this row: the label truncates before it.
						"flex min-h-8 items-center pe-40 ps-5 text-sm text-neutral-500"
					: "px-5 pb-1 pt-3 text-sm text-neutral-500 first:pt-1"
			}
		>
			<p aria-hidden="true" className="min-w-0 truncate">
				{section.label}
				{section.count !== null && <span className="ms-2">[{section.count}]</span>}
			</p>
		</div>
	);
}

/**
 * The pager of a list with a section label: a zero-height sticky anchor just above the first label whose pager
 * sits over the label row's end, then stays at the top while the list scrolls (only the pager sticks, not the label).
 */
export function StickyPager({ pager }: { pager: MessageListPagerState }) {
	return (
		<div role="listitem" className="sticky top-0 z-20 h-0">
			<div className={clsx(PAGER_BOX, "absolute end-0 top-0 h-8 justify-end")}>
				<ListPager pager={pager} />
			</div>
		</div>
	);
}
