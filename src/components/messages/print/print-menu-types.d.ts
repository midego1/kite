import type { PrintSource } from "./print-types";

/** What a menu prints: the open message, or its conversation in conversation view. */
export type ReaderPrint = {
	/** Labels the items for the whole conversation. */
	conversation: boolean;
	/** The messages to print, oldest first; read when an item is chosen. */
	getSources: () => PrintSource[];
};

export type PrintMenuItemsProps = {
	print: ReaderPrint | undefined;
	/** Closes the menu. */
	onSelect?: () => void;
};
