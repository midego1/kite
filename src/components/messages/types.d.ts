import type { MouseEvent } from "react";
import type { RowMessageIdsLookup } from "./open-row-context";
import type { LucideIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Message, MessageFolder } from "@/hooks/types";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageListDensity } from "./reading-layout-types";
import type { RowClickModifiers } from "./message-range-selection-utils";

export type MessageFolderConfig = {
	folder: MessageFolder;
	title: string;
	emptyText: string;
	hrefPrefix: string;
	folderId?: string;
	icon: LucideIcon;
	headerIcons?: LucideIcon[];
	badgeVariant?: "default" | "secondary" | "outline";
	showRowBadge?: boolean;
};

export type MessageListRowProps = {
	message: Message;
	config: MessageFolderConfig;
	selected: boolean;
	active?: boolean;
	compact?: boolean;
	density?: MessageListDensity;
	/** Hover-revealed row actions; touch screens use swipes instead. */
	hoverActions?: boolean;
	/** "Select" is on, so every row shows its checkbox in place of the avatar. */
	selecting?: boolean;
	currentAccountName?: string;
	/** The row's mailbox in the All mailboxes view (`MessageMailboxLabel`). */
	mailboxLabel?: ReactNode;
	/** False for read-only shared mail: the row offers no archive, trash or swipe to archive. */
	canManage?: boolean;
	/** `extendRange` is set for Shift-click and selects every row since the last one clicked. */
	onSelectedChange: (messageId: string, selected: boolean, extendRange?: boolean) => void;
	/**
	 * Every primary click on the row; `modifiers` is set for Shift-, Cmd- and Ctrl-click, which select the row
	 * instead of opening it.
	 */
	onRowClick?: (messageId: string, modifiers: RowClickModifiers | null) => void;
	onMessageAction: (messageId: string, action: RowMessageAction) => Promise<void>;
	dragMessageIds: string[];
};

export type RowMessageAction = "archive" | "trash" | "read" | "unread";

export type MessageListRowActionsProps = {
	message: Message;
	onAction: (action: RowMessageAction) => Promise<void>;
	/** Placement for the stacked rows of the list beside a reading pane. */
	compact?: boolean;
	/** The star toggle, first in the pill of the stacked rows (Zero's row actions). */
	star?: { starred: boolean; icon: LucideIcon; onToggle: (event: MouseEvent<HTMLButtonElement>) => void };
};

export type SnoozePickerProps = {
	messageId: string;
	/** Called once the message is snoozed, to close whatever holds the picker. */
	onSnoozed: () => void;
};

export type SnoozeMenuItemProps = SnoozePickerProps & {
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
};

export type MessageFolderPageProps = {
	config: MessageFolderConfig;
	compact?: boolean;
	selectedMessageId?: string;
	selection?: MessageSelectionControl;
	/** False while the split layout has the list panel hidden; the header then stops claiming the sidebar toggle. */
	listVisible?: boolean;
};

export type MessageSplitLayoutProps = {
	children: ReactNode;
	config: MessageFolderConfig;
};

export type MessageListVisibility = {
	visible: boolean;
	toggle: () => void;
	singleColumn: boolean;
	/** The list sits above the reading pane rather than beside it. */
	stacked: boolean;
	backHref: string;
	backLabel: string;
};

export type BulkMessageToolbarProps = {
	selectedCount: number;
	hasUnreadSelection: boolean;
	hideSelectedCount?: boolean;
	onAction: (action: BulkMessageAction, folderId?: string) => void;
	onClearSelection: () => void;
	pending: boolean;
	/** Folder being listed; archived, spam and trash offer a way back instead of the same move. */
	folder?: MessageFolder;
	/** The mailbox of each selected row: folders are offered for one mailbox only, and read-only mail stays put. */
	mailboxIds?: Array<string | null | undefined>;
	/** The selection holds the user's own drafts, so Delete stays on without full access to their mailbox. */
	hasDraftSelection?: boolean;
	/** The selection holds a message waiting to be sent, which can only be cancelled, so the moving actions are off. */
	hasPendingSendSelection?: boolean;
};

/** A selected row; `status` lets a member without full access still delete their own drafts. */
export type SelectedMessage = Pick<Message, "id" | "read"> & { mailboxId?: string | null; status?: string };

export type BulkSelectionAction = (action: BulkMessageAction, folderId?: string) => Promise<void>;

export type MessageSelectionControl = {
	selectedMessages: SelectedMessage[];
	setSelectedMessages: Dispatch<SetStateAction<SelectedMessage[]>>;
	/**
	 * Filled in by the list with its own bulk action runner, so a selection pane
	 * elsewhere gets the same thread expansion, confirmation and optimistic updates.
	 */
	registerAction?: (run: BulkSelectionAction | null) => void;
	/**
	 * Empties the reading pane at once and navigates to the list, so the open message's detail is
	 * unmounted (no refetch, no 404 once deleted) until the list route has committed.
	 */
	leaveOpenMessage?: () => void;
	/** Filled in by the list with a lookup of the ids each row stands for, which the reader's moves act on. */
	registerRowLookup?: (lookup: RowMessageIdsLookup | null) => void;
};

export type BulkMessageSelectionPaneProps = {
	folder?: MessageFolder;
	selectedMessages: SelectedMessage[];
	onAction: BulkSelectionAction;
	onClearSelection: () => void;
};

export type PageRange = {
	start: number;
	end: number;
	total: number;
};

export type EmailPageTitleInput = {
	location: string;
	total: number;
	unread: number;
	emailAddress: string | null;
};
