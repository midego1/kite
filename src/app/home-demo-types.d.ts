import type { LucideIcon } from "lucide-react";
import type { FormEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";

/*
 * The interactive demo in the hero: invented mail in a small, local model of the inbox. Everything here is
 * plain data; the reducer in home-demo-state-utils.ts changes it and the parts in home-demo-parts.tsx,
 * home-demo-reader.tsx and home-demo-panels.tsx draw it.
 */

export type DemoPerson = {
	name: string;
	address: string;
	initial: string;
	/** Tailwind classes of the avatar circle, as the real list colours them per sender. */
	avatarClassName: string;
};

export type DemoAttachment = {
	name: string;
	size: string;
	iconClassName: string;
};

export type DemoSuggestionKind = "reply" | "invite" | "subscription";

export type DemoSuggestion = {
	kind: DemoSuggestionKind;
	title: string;
	text: string;
	/** The button that takes the suggestion: review a draft, accept an invitation, track a subscription. */
	actionLabel: string;
};

export type DemoSummary = {
	overview: string;
	points: string[];
};

export type DemoEarlierMessage = {
	from: DemoPerson;
	time: string;
	body: string;
};

export type DemoStatus = "inbox" | "archived" | "trash" | "sent" | "draft";

export type DemoMessage = {
	id: string;
	from: DemoPerson;
	to: string;
	subject: string;
	time: string;
	sentAt: string;
	status: DemoStatus;
	/** A user folder (the demo has one, Receipts); such mail is listed there instead of in the Inbox. */
	folder?: "receipts";
	/** The Screener has not decided on this sender yet: the row carries "New sender" and the Screener lists it. */
	screening?: boolean;
	unread: boolean;
	starred: boolean;
	snoozed: boolean;
	body: string[];
	participants: DemoPerson[];
	attachments: DemoAttachment[];
	earlier?: DemoEarlierMessage[];
	badge?: { icon: LucideIcon; label: string; className: string };
	suggestion?: DemoSuggestion;
	summary: DemoSummary;
};

export type DemoListView = "inbox" | "screener" | "starred" | "snoozed" | "sent" | "drafts" | "receipts";
export type DemoPanelView = "for-you" | "calendar" | "drive" | "subscriptions";
export type DemoView = DemoListView | DemoPanelView;

export type DemoSidebarItem = {
	view: DemoView;
	label: string;
	icon: LucideIcon;
};

export type DemoToast = {
	text: string;
	/** The messages before the change, for Undo. */
	undo: DemoMessage[] | null;
};

export type DemoComposer = {
	to: string;
	subject: string;
	body: string;
	/** Says who wrote the body when it came from a suggestion, as the app's send review does. */
	fromAssistant: boolean;
	/** The message replied to; sending a reviewed draft closes its suggestion. */
	messageId: string;
};

export type DemoChatTurn = {
	role: "user" | "assistant";
	text: string;
};

export type DemoState = {
	messages: DemoMessage[];
	view: DemoView;
	openId: string | null;
	/** Which pane a phone shows; wider screens show both. */
	mobilePane: "list" | "reader";
	menuOpen: boolean;
	search: string;
	updateRow: boolean;
	toast: DemoToast | null;
	composer: DemoComposer | null;
	chatOpen: boolean;
	chat: DemoChatTurn[];
	/** Ids whose canned summary is shown in the reader. */
	summarized: string[];
	/** Ids whose earlier messages are unfolded. */
	expanded: string[];
};

export type DemoActionType =
	| "open"
	| "close"
	| "back"
	| "view"
	| "search"
	| "star"
	| "archive"
	| "trash"
	| "snooze"
	| "undo"
	| "dismissToast"
	| "approve"
	| "deny"
	| "takeSuggestion"
	| "dismissSuggestion"
	| "reply"
	| "send"
	| "closeComposer"
	| "dismissUpdate"
	| "toggleChat"
	| "chatSend"
	| "summarize"
	| "expand"
	| "toggleMenu"
	| "move";

export type DemoAction = {
	type: DemoActionType;
	id?: string;
	view?: DemoView;
	text?: string;
	direction?: 1 | -1;
};

/** What a clicked button carries; the host keeps it as plain strings so it never imports the demo's code. */
export type DemoClick = { action?: string; id?: string; view?: string };

/** The demo's counts for the sidebar. */
export type DemoCounts = Partial<Record<DemoView, number>>;

/**
 * The parts take the state and, in the interactive demo, a `live` flag. Buttons carry `data-action` (and
 * `data-id`, `data-view`) and the client demo handles them with one delegated click handler, so the same
 * parts render on the server without any function props.
 */
export type DemoPartProps = {
	state: DemoState;
	live: boolean;
	appName: string;
};

export type DemoFrameProps = DemoPartProps & {
	/** Inputs and the chat form are handled only in the live demo; the static render leaves them read-only. */
	onSearch?: (query: string) => void;
	onChatInput?: (text: string) => void;
	onChatSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	chatInput?: string;
	/** The live demo's delegated handlers on the frame's root, and its reference for focus management. */
	onClick?: (event: MouseEvent<HTMLDivElement>) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	rootRef?: RefObject<HTMLDivElement | null>;
};

export type DemoRowProps = {
	message: DemoMessage;
	selected: boolean;
	screener: boolean;
};

export type DemoHostProps = {
	appName: string;
	children: ReactNode;
};

export type HomeDemoProps = {
	appName: string;
	/** The `data-*` of a button clicked on the static frame before the demo loaded, applied to the opening state. */
	initialAction?: DemoClick | null;
};

export type DemoPanelTeaserProps = {
	title: string;
	text: string;
	children: ReactNode;
};
