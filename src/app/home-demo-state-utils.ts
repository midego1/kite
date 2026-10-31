import { demoChatOpening, demoChatReplies, demoMessages } from "./home-demo-data";
import type {
	DemoAction,
	DemoActionType,
	DemoCounts,
	DemoListView,
	DemoMessage,
	DemoPanelView,
	DemoState,
	DemoView,
} from "./home-demo-types";

/*
 * The demo's state and the pure functions that change it. Nothing here touches the network, storage or the
 * DOM, so the server renders the opening state and the client continues from it.
 */

const PANEL_VIEWS: DemoPanelView[] = ["for-you", "calendar", "drive", "subscriptions"];

export function isPanelView(view: DemoView): view is DemoPanelView {
	return (PANEL_VIEWS as DemoView[]).includes(view);
}

export function createDemoState(): DemoState {
	return {
		messages: demoMessages.map((message) => ({ ...message })),
		view: "inbox",
		openId: "launch-plan",
		mobilePane: "list",
		menuOpen: false,
		search: "",
		updateRow: true,
		toast: null,
		composer: null,
		chatOpen: false,
		chat: [{ role: "assistant", text: demoChatOpening }],
		summarized: [],
		expanded: [],
	};
}

const LIST_FILTERS: Record<DemoListView, (message: DemoMessage) => boolean> = {
	inbox: (m) => m.status === "inbox" && !m.folder && !m.snoozed,
	screener: (m) => m.status === "inbox" && !!m.screening,
	starred: (m) => m.starred && m.status !== "trash",
	snoozed: (m) => m.snoozed && m.status === "inbox",
	sent: (m) => m.status === "sent",
	drafts: (m) => m.status === "draft",
	receipts: (m) => m.status === "inbox" && m.folder === "receipts",
};

function matchesSearch(message: DemoMessage, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [message.subject, message.from.name, message.from.address, ...message.body].some((text) =>
		text.toLowerCase().includes(needle),
	);
}

/** The rows of a list view, in the stored order, narrowed by the search box. */
export function listMessages(state: DemoState, view: DemoView = state.view): DemoMessage[] {
	if (isPanelView(view)) return [];
	return state.messages.filter((message) => LIST_FILTERS[view](message) && matchesSearch(message, state.search));
}

/** Mail with an open suggestion, for the For you view and its sidebar count. */
export function suggestedMessages(state: DemoState): DemoMessage[] {
	return state.messages.filter((m) => m.status === "inbox" && !!m.suggestion);
}

export function demoCounts(state: DemoState): DemoCounts {
	return {
		inbox: state.messages.filter((m) => LIST_FILTERS.inbox(m) && m.unread).length,
		screener: state.messages.filter(LIST_FILTERS.screener).length,
		"for-you": suggestedMessages(state).length,
		drafts: state.messages.filter(LIST_FILTERS.drafts).length,
		subscriptions: 1,
	};
}

export function findMessage(state: DemoState, id: string | null | undefined): DemoMessage | undefined {
	return id ? state.messages.find((m) => m.id === id) : undefined;
}

function replySubject(subject: string): string {
	return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function patchMessage(state: DemoState, id: string, patch: Partial<DemoMessage>): DemoMessage[] {
	return state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

/** A change to one message that closes the reader and can be undone from the toast. */
function undoable(state: DemoState, id: string, patch: Partial<DemoMessage>, text: string): DemoState {
	return {
		...state,
		messages: patchMessage(state, id, patch),
		openId: state.openId === id ? null : state.openId,
		mobilePane: state.openId === id ? "list" : state.mobilePane,
		toast: { text, undo: state.messages },
	};
}

function open(state: DemoState, id: string): DemoState {
	if (!findMessage(state, id)) return state;
	return {
		...state,
		messages: patchMessage(state, id, { unread: false }),
		// Opening from For you lands in the Inbox, where the reader is.
		view: isPanelView(state.view) ? "inbox" : state.view,
		openId: id,
		mobilePane: "reader",
		menuOpen: false,
	};
}

const SUGGESTION_TAKEN: Record<string, (message: DemoMessage) => string> = {
	invite: (m) => `Accepted. ${m.from.name} gets your answer and the event is on your calendar.`,
	subscription: () => "Tracking Fabrikam under Subscriptions, with a reminder before 3 November.",
	reply: () => "Draft opened.",
};

function takeSuggestion(state: DemoState, id: string): DemoState {
	const message = findMessage(state, id);
	if (!message?.suggestion) return state;
	if (message.suggestion.kind === "reply") {
		return {
			...state,
			composer: {
				to: message.from.address,
				subject: replySubject(message.subject),
				body: message.suggestion.text,
				fromAssistant: true,
				messageId: id,
			},
		};
	}
	return {
		...state,
		messages: patchMessage(state, id, { suggestion: undefined, badge: undefined }),
		toast: { text: SUGGESTION_TAKEN[message.suggestion.kind](message), undo: state.messages },
	};
}

function move(state: DemoState, direction: 1 | -1): DemoState {
	const rows = listMessages(state);
	if (rows.length === 0) return state;
	const index = rows.findIndex((m) => m.id === state.openId);
	const next = rows[index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + direction))];
	return open(state, next.id);
}

function chatSend(state: DemoState, text: string): DemoState {
	const question = text.trim();
	if (!question) return state;
	const asked = state.chat.filter((turn) => turn.role === "user").length;
	const reply = demoChatReplies[Math.min(asked, demoChatReplies.length - 1)];
	return { ...state, chat: [...state.chat, { role: "user", text: question }, { role: "assistant", text: reply }] };
}

function toggle(list: string[], id: string): string[] {
	return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

const withId =
	(handler: (state: DemoState, id: string) => DemoState) =>
	(state: DemoState, action: DemoAction): DemoState =>
		action.id ? handler(state, action.id) : state;

const HANDLERS: Record<DemoActionType, (state: DemoState, action: DemoAction) => DemoState> = {
	open: withId(open),
	close: (state) => ({ ...state, openId: null, mobilePane: "list" }),
	back: (state) => ({ ...state, mobilePane: "list" }),
	view: (state, { view }) =>
		view ? { ...state, view, openId: null, search: "", mobilePane: "list", menuOpen: false } : state,
	search: (state, { text }) => ({ ...state, search: text ?? "" }),
	star: withId((state, id) => {
		const message = findMessage(state, id);
		return message ? { ...state, messages: patchMessage(state, id, { starred: !message.starred }) } : state;
	}),
	archive: withId((state, id) => undoable(state, id, { status: "archived" }, "Archived")),
	trash: withId((state, id) => undoable(state, id, { status: "trash" }, "Moved to Trash")),
	snooze: withId((state, id) => undoable(state, id, { snoozed: true }, "Snoozed until tomorrow, 8:00 AM")),
	undo: (state) => (state.toast?.undo ? { ...state, messages: state.toast.undo, toast: null } : state),
	dismissToast: (state) => ({ ...state, toast: null }),
	approve: withId((state, id) => {
		const message = findMessage(state, id);
		return message
			? {
					...state,
					messages: patchMessage(state, id, { screening: false }),
					toast: { text: `Approved. Mail from ${message.from.name} now arrives in your Inbox.`, undo: state.messages },
				}
			: state;
	}),
	deny: withId((state, id) => {
		const message = findMessage(state, id);
		return message
			? undoable(
					state,
					id,
					{ status: "trash", screening: false },
					`Denied. Mail from ${message.from.name} goes to Trash.`,
				)
			: state;
	}),
	takeSuggestion: withId(takeSuggestion),
	dismissSuggestion: withId((state, id) => ({
		...state,
		messages: patchMessage(state, id, { suggestion: undefined, badge: undefined }),
		toast: { text: "Suggestion dismissed", undo: state.messages },
	})),
	reply: withId((state, id) => {
		const message = findMessage(state, id);
		return message
			? {
					...state,
					composer: {
						to: message.from.address,
						subject: replySubject(message.subject),
						body: "",
						fromAssistant: false,
						messageId: id,
					},
				}
			: state;
	}),
	send: (state) => ({
		...state,
		// A reviewed draft that was "sent" closes its suggestion, as taking one in the app does.
		messages: state.composer?.fromAssistant
			? patchMessage(state, state.composer.messageId, { suggestion: undefined })
			: state.messages,
		composer: null,
		toast: { text: "Demo: nothing sent", undo: null },
	}),
	closeComposer: (state) => ({ ...state, composer: null }),
	dismissUpdate: (state) => ({ ...state, updateRow: false }),
	toggleChat: (state) => ({ ...state, chatOpen: !state.chatOpen }),
	chatSend: (state, { text }) => chatSend(state, text ?? ""),
	summarize: withId((state, id) => ({ ...state, summarized: toggle(state.summarized, id) })),
	expand: withId((state, id) => ({ ...state, expanded: toggle(state.expanded, id) })),
	toggleMenu: (state) => ({ ...state, menuOpen: !state.menuOpen }),
	move: (state, { direction }) => (direction ? move(state, direction) : state),
};

export function reduceDemo(state: DemoState, action: DemoAction): DemoState {
	return HANDLERS[action.type](state, action);
}

/** Reads a button's `data-action`, `data-id` and `data-view` into an action; null for anything else. */
export function actionFromDataset(dataset: { action?: string; id?: string; view?: string }): DemoAction | null {
	const type = dataset.action as DemoActionType | undefined;
	if (!type || !(type in HANDLERS)) return null;
	return { type, id: dataset.id, view: dataset.view as DemoView | undefined };
}
