import type { Dispatch, SetStateAction } from "react";
import type { MessageListPagerState } from "./message-list-pager-types";
import type { PageRange } from "./types";

type ListPagerInput = {
	range: PageRange;
	offset: number;
	limit: number;
	/** Rows on the current page. */
	shown: number;
	total: number;
	isLoading: boolean;
	nextCursor: string | null | undefined;
	setOffset: (offset: number) => void;
	setPageCursors: Dispatch<SetStateAction<Record<number, string>>>;
};

/** The pager's state: arrows are off while a page loads, and Next remembers the cursor of the page it leaves for. */
export function buildListPager(input: ListPagerInput): MessageListPagerState {
	const { offset, limit, shown, total, isLoading, nextCursor } = input;
	return {
		range: input.range,
		canPrevious: offset > 0 && !isLoading,
		canNext: offset + shown < total && !isLoading,
		previous: () => input.setOffset(Math.max(offset - limit, 0)),
		next: () => {
			const nextOffset = offset + limit;
			if (nextCursor) input.setPageCursors((current) => ({ ...current, [nextOffset]: nextCursor }));
			input.setOffset(nextOffset);
		},
	};
}

/** More than one page, and not while the bulk toolbar replaces the header (a page change drops that selection). */
export function isPagerShown(pager: MessageListPagerState, bulk: boolean): boolean {
	return (pager.canPrevious || pager.canNext) && !bulk;
}
