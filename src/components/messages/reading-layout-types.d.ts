import type { MessageFolderConfig } from "./types";

/** Where an open message appears relative to the message list. */
export type ReadingPaneMode = "none" | "right" | "below";

/** How much vertical space each message list row takes. */
export type MessageListDensity = "default" | "comfortable" | "compact";

export type ReadingLayoutOption<T extends string> = {
	value: T;
	label: string;
	description: string;
};

export type MessageRowDensityStyle = {
	/** Padding and minimum height classes for the row. */
	rowClassName: string;
	/** Whether the stacked (split list) row shows its snippet line. */
	showPreview: boolean;
};

export type ReadingPaneEmptyStateProps = {
	config: MessageFolderConfig;
};
