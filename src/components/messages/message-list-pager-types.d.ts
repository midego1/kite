import type { PageRange } from "./types";

export type MessageListPagerState = {
	range: PageRange;
	canPrevious: boolean;
	canNext: boolean;
	previous: () => void;
	next: () => void;
};
