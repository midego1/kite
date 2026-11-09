import type { MessageKey } from "@/lib/i18n/i18n-types";
import type { MouseEvent } from "react";
import type { RowMessageIdsLookup } from "./open-row-context";
import type { LucideIcon } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Message, MessageFolder } from "@/hooks/types";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageListDensity, MessageListLabels } from "./reading-layout-types";
import type { RowClickModifiers } from "./message-range-selection-utils";

/** A folder's name: a key for a built-in one, or what its owner typed for a custom one, which is never translated. */
export type MessageFolderName = { folderId?: undefined; title: MessageKey } | { folderId: string; title: string };

export type MessageFolderConfig = MessageFolderName & {
	folder: MessageFolder;
	emptyText: MessageKey;
	hrefPrefix: string;
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
	/** How the row shows its connected account (and sizes the subject for its mailbox label); `compact` by default. */
	labels?: MessageListLabels;
	/** Some row of the list came in through a connected account: rows without one keep its slot, so subjects line up. */
	viaSlot?: boolean;
	/** The row's mailbox in the All mailboxes view (`MessageMailboxLabel`). */
	mailboxLabel?: ReactNode;
	/** False for read-only shared mail: the row offers no archive, trash or swipe to archive. */
	canManage?: boolean;
	/** `extendRange` is set for Shift-click and selects every row since the last one clicked. */
	onSelectedChange: (messageId: string, selected: boolean, extendRange?: boolean) => void;
	/** A touch long press: selects the row and turns "Select" on, so every other row's checkbox shows too. */
	onLongPressSelect?: (messageId: string) => void;
	/**
	 * Every primary click on the row; `modifiers` is set for Shift-, Cmd- and Ctrl-click, which select the row
	 * instead of opening it.
	 */
	onRowClick?: (messageId: string, modifiers: RowClickModifiers | null) => void;
	onMessageAction: (messageId: string, action: RowMessageAction, folderId?: string) => Promise<void>;
	dragMessageIds: string[];
};

/** The row-level actions a single message supports; the same set `runBulkMessageAction` accepts. */
export type RowMessageAction = BulkMessageAction;

export type MessageListRowActionsProps = {
	message: Message;
	onAction: (action: RowMessageAction) => Promise<void>;
	/** Placement for the stacked rows of the list beside a reading pane. */
	compact?: boolean;
	/** The star toggle, first in the pill of the stacked rows (Zero's row actions). */
	star?: { starred: boolean; icon: LucideIcon; onToggle: (event: MouseEvent<HTMLButtonElement>) => void };
	/** Show the pill on mouse hover, below the narrowest compact rows even with a mouse. Default true. */
	hoverReveal?: boolean;
};

export type RowActionsMenuProps = {
	message: Message;
	/** For the trigger's accessible name, as `rowCheckboxLabel` uses it: "More actions for {party}". */
	party: string;
	onAction: (action: RowMessageAction, folderId?: string) => Promise<void>;
	/** Absent in the Snoozed folder, where a row cannot be starred. */
	star?: { starred: boolean; icon: LucideIcon; onToggle: (event: MouseEvent<HTMLButtonElement>) => void };
	/** The wide (single-line, desktop-style) row anchors the trigger differently than a stacked row. */
	compact?: boolean;
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

/**
 * A selected row; `status` lets a member without full access still delete their own drafts.
 * `threadMessageIds` (conversation view) travels with the row itself, so a selection built from
 * a page beyond the one loaded in the list, as "Select all in folder" does, can still expand to
 * every message of its thread. `offPage` is set on every row "Select all" selected, whether or not it
 * happened to be on the loaded page at the time, since new mail or a move can push it out afterward; a
 * refresh of that page must never prune it away. `direction`,
 * `threadUnread` and `threadInboundCount` travel the same way, so marking such a row read or unread
 * can still work out its effect on the sidebar Inbox count without a row on the loaded page to read it from.
 */
export type SelectedMessage = Pick<Message, "id" | "read" | "direction"> & {
	mailboxId?: string | null;
	status?: string;
	threadMessageIds?: string[];
	threadUnread?: number;
	threadInboundCount?: number;
	offPage?: boolean;
};

export type BulkSelectionAction = (action: BulkMessageAction, folderId?: string) => Promise<void>;

export type MessageSelectionControl = {
	selectedMessages: SelectedMessage[];
	setSelectedMessages: Dispatch<SetStateAction<SelectedMessage[]>>;
	/**
	 * Which list and page `selectedMessages` was made on. The list clears the selection when this changes, but not
	 * when it only remounts on the same list (a direction switch rebuilds the panel group), which keeps what is checked.
	 */
	listIdentity?: { current: string | null };
	/**
	 * Empties the reading pane at once and navigates to the list, so the open message's detail is
	 * unmounted (no refetch, no 404 once deleted) until the list route has committed.
	 */
	leaveOpenMessage?: () => void;
	/** Filled in by the list with a lookup of the ids each row stands for, which the reader's moves act on. */
	registerRowLookup?: (lookup: RowMessageIdsLookup | null) => void;
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
