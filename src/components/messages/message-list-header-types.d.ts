import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageFolderConfig, PageRange } from "./types";

export type MessageListFilter = "all" | "unread";

export type MessageListHeaderProps = {
	config: MessageFolderConfig;
	/** The list beside a reading pane: the title row and a slim pager row below it. */
	compact: boolean;
	/** A selection pane next to the list offers the bulk actions, so the header skips them. */
	selectionInPane: boolean;
	showTitle: boolean;
	nested: boolean;
	selection: {
		count: number;
		allVisible: boolean;
		hasUnread: boolean;
		disabled: boolean;
		pending: boolean;
		/** The mailbox of each selected row, for the folders and actions the toolbar offers. */
		mailboxIds: Array<string | null | undefined>;
		/** The selection holds the user's own drafts, which they may delete whatever their mailbox access. */
		hasDrafts?: boolean;
		toggleAll: (selected: boolean) => void;
		run: (action: BulkMessageAction, folderId?: string) => Promise<void>;
		clear: () => void;
	};
	/** Whether the rows show their checkboxes (Zero's "Select"). */
	selecting: { value: boolean; onChange: (value: boolean) => void };
	/** Whether the Inbox's chips link to the Screener. */
	screenerVisible: boolean;
	filter: { value: MessageListFilter; onChange: (value: MessageListFilter) => void } | null;
	pager: {
		range: PageRange;
		canPrevious: boolean;
		canNext: boolean;
		previous: () => void;
		next: () => void;
	};
	emptyFolder: { folder: "trash" | "spam"; disabled: boolean; emptying: boolean; run: () => void } | null;
};
