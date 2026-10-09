import type { ReactNode } from "react";

export type ReadingLayoutSegmentProps = {
	checked: boolean;
	label: string;
	description: string;
	onSelect: () => void;
	children: ReactNode;
};
