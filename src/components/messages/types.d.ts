import type { LucideIcon } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Message, MessageFolder } from "@/hooks/types";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageListDensity } from "./reading-layout-types";

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
	currentAccountName?: string;
	/** `extendRange` is set for Shift-click and selects every row since the last one clicked. */
	onSelectedChange: (messageId: string, selected: boolean, extendRange?: boolean) => void;
	onMessageAction: (messageId: string, action: RowMessageAction) => Promise<void>;
	dragMessageIds: string[];
};

export type RowMessageAction = "archive" | "trash" | "read" | "unread";

export type MessageListRowActionsProps = {
	message: Message;
	onAction: (action: RowMessageAction) => Promise<void>;
	/** Placement for the stacked rows of the list beside a reading pane. */
	compact?: boolean;
};

export type MessageFolderPageProps = {
	config: MessageFolderConfig;
	compact?: boolean;
	selectedMessageId?: string;
	selection?: MessageSelectionControl;
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
};

export type SelectedMessage = Pick<Message, "id" | "read">;

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
