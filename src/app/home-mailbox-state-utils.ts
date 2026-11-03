import type {
	HomeEmailMeta,
	HomeFolderId,
	HomeMailboxAction,
	HomeMailboxState,
	HomeViewId,
} from "./home-mailbox-types";

/*
 * The mailbox's state and the pure functions that change it. Nothing here touches the network, storage or the
 * DOM, so the server renders the opening state (the Welcome email open) and the client continues from it.
 */

export const FOLDERS: { id: HomeFolderId; label: string }[] = [
	{ id: "inbox", label: "Inbox" },
	{ id: "deploy", label: "Deploy" },
	{ id: "cost", label: "Cost" },
	{ id: "compare", label: "Compare" },
	{ id: "limits", label: "Limits" },
	{ id: "faq", label: "FAQ" },
];

export const WELCOME_ID = "welcome";

/** Old section anchors that name a whole folder, and the email they open. */
const ALIASES: Record<string, string> = { features: "features-intro", faq: "faq-mailflare" };

/** The email a URL hash names, or the Welcome email for an empty, malformed or unknown one. */
export function emailFromHash(hash: string, emails: HomeEmailMeta[]): string {
	let id: string;
	try {
		id = decodeURIComponent(hash.replace(/^#/, ""));
	} catch {
		// A malformed escape (/#%) must not break the page.
		return WELCOME_ID;
	}
	const target = ALIASES[id] ?? id;
	return emails.some((email) => email.id === target) ? target : WELCOME_ID;
}

export function viewTitle(view: HomeViewId): string {
	return view === "starred" ? "Starred" : (FOLDERS.find((folder) => folder.id === view)?.label ?? "Inbox");
}

function matches(email: HomeEmailMeta, query: string, dismissed: boolean): boolean {
	// A dismissed suggestion card no longer shows its draft, so the search must not match it either.
	const text =
		dismissed && email.sample?.suggestion ? email.text.replace(email.sample.suggestion.text, "") : email.text;
	return text.toLowerCase().includes(query.trim().toLowerCase());
}

/** The rows of a view; a search looks through every folder. */
export function listEmails(state: HomeMailboxState, emails: HomeEmailMeta[]): HomeEmailMeta[] {
	if (state.search.trim())
		return emails.filter((email) => matches(email, state.search, state.dismissed.includes(email.id)));
	if (state.view === "starred") return emails.filter((email) => state.starred.includes(email.id));
	return emails.filter((email) => email.folder === state.view);
}

export function unreadCount(state: HomeMailboxState, emails: HomeEmailMeta[], view: HomeViewId): number {
	return emails.filter(
		(email) =>
			!state.read.includes(email.id) && (view === "starred" ? state.starred.includes(email.id) : email.folder === view),
	).length;
}

export function createMailboxState(): HomeMailboxState {
	return {
		view: "inbox",
		openId: WELCOME_ID,
		search: "",
		read: [WELCOME_ID],
		starred: [],
		menuOpen: false,
		// The Welcome email is what a phone opens on, so the page reads without a tap.
		pane: "reader",
		composer: null,
		dismissed: [],
		decided: [],
		toast: null,
		contactCard: null,
	};
}

function open(state: HomeMailboxState, emails: HomeEmailMeta[], id: string): HomeMailboxState {
	const email = emails.find((candidate) => candidate.id === id);
	if (!email) return state;
	return {
		...state,
		// Opening from the search or a link lands in the email's own folder, so the list and the reader agree
		// once the search is cleared; only Starred keeps its cross-folder list.
		view: state.view === "starred" ? state.view : email.folder,
		openId: id,
		read: state.read.includes(id) ? state.read : [...state.read, id],
		pane: "reader",
		menuOpen: false,
		contactCard: null,
	};
}

type Handler<T extends HomeMailboxAction["type"]> = (
	state: HomeMailboxState,
	action: Extract<HomeMailboxAction, { type: T }>,
	emails: HomeEmailMeta[],
) => HomeMailboxState;

const HANDLERS: { [T in HomeMailboxAction["type"]]: Handler<T> } = {
	open: (state, action, emails) => open(state, emails, action.id),
	view: (state, action, emails) => {
		const first = emails.find((email) => email.folder === action.view);
		return {
			...state,
			view: action.view,
			search: "",
			menuOpen: false,
			contactCard: null,
			// Wider screens keep a message in the reader; a phone shows the list.
			openId: action.view === "starred" ? state.openId : (first?.id ?? state.openId),
			// Only a shown email becomes read: on a phone the reader is hidden, so the first email stays unread.
			read: first && !action.phone && !state.read.includes(first.id) ? [...state.read, first.id] : state.read,
			pane: "list",
		};
	},
	search: (state, action) => ({ ...state, search: action.text, pane: "list", contactCard: null }),
	star: (state, action) => ({
		...state,
		starred: state.starred.includes(action.id)
			? state.starred.filter((id) => id !== action.id)
			: [...state.starred, action.id],
	}),
	back: (state) => ({ ...state, pane: "list", contactCard: null }),
	toggleMenu: (state) => ({ ...state, menuOpen: !state.menuOpen }),
	closeMenu: (state) => ({ ...state, menuOpen: false }),
	openContact: (state, action) => ({
		...state,
		contactCard: state.contactCard?.address === action.address ? null : { address: action.address, left: action.left },
	}),
	closeContact: (state) => ({ ...state, contactCard: null }),
	// An email counts as read once it is shown: a folder tapped on a phone opens its first email unseen.
	markRead: (state, action) =>
		state.read.includes(action.id) ? state : { ...state, read: [...state.read, action.id] },
	// The composer opens over the page, so a menu below lg closes: its Close button would otherwise take the next Tab.
	compose: (state, action) => ({
		...state,
		composer: { to: action.to, subject: action.subject, body: action.body ?? "" },
		contactCard: null,
		menuOpen: false,
	}),
	closeComposer: (state) => ({ ...state, composer: null }),
	dismissSuggestion: (state, action) => ({
		...state,
		dismissed: [...state.dismissed, action.id],
		toast: { text: "Suggestion dismissed", n: (state.toast?.n ?? 0) + 1 },
	}),
	decideSender: (state, action, emails) => {
		const name = emails.find((email) => email.id === action.id)?.sample?.sender.name ?? "this sender";
		const text = action.approve
			? `Approved. Mail from ${name} now arrives in your Inbox.`
			: `Denied. Mail from ${name} goes to Trash.`;
		return { ...state, decided: [...state.decided, action.id], toast: { text, n: (state.toast?.n ?? 0) + 1 } };
	},
	send: (state) => ({ ...state, composer: null, toast: { text: "Demo: nothing sent", n: (state.toast?.n ?? 0) + 1 } }),
	toast: (state, action) => ({ ...state, toast: { text: action.text, n: (state.toast?.n ?? 0) + 1 } }),
	dismissToast: (state) => ({ ...state, toast: null }),
	move: (state, action, emails) => {
		const rows = listEmails(state, emails);
		if (rows.length === 0) return state;
		const index = rows.findIndex((email) => email.id === state.openId);
		const next = rows[index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + action.direction))];
		return open(state, emails, next.id);
	},
};

export function reduceMailbox(
	state: HomeMailboxState,
	action: HomeMailboxAction,
	emails: HomeEmailMeta[],
): HomeMailboxState {
	return (HANDLERS[action.type] as Handler<typeof action.type>)(state, action, emails);
}
