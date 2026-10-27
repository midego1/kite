import type { ThreadMessage } from "@/hooks/types";

export type ConversationThreadProps = {
	/** The message the reader is currently viewing; it is rendered by the page, not here. */
	currentMessageId: string;
	/** Which side of the current message to render. */
	position: "before" | "after";
	messages: ThreadMessage[];
	mailboxId: string | null;
	currentAccountName?: string;
	ownAddress?: string | null;
	ownAddresses?: string[];
	latestMessagesFirst: boolean;
	expandedAll: boolean;
	onExpandedAllChange: (expanded: boolean) => void;
	showFullRecipientAddresses?: boolean;
	/** The current message's thread; the Kite suggestion card covers the whole conversation. */
	threadId?: string | null;
	/** Hides the suggestion card's summary line while a current Summarize summary is shown. */
	hideTriageSummary?: boolean;
};

export type ConversationMessageCardProps = {
	message: ThreadMessage;
	mailboxId: string | null;
	currentAccountName?: string;
	ownAddress?: string | null;
	ownAddresses?: string[];
	defaultExpanded?: boolean;
	showFullRecipientAddresses?: boolean;
};

export type UseMessageThreadResult = {
	messages: ThreadMessage[];
	loading: boolean;
};
