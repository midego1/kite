import type { ReactNode } from "react";

/*
 * The home page is a mailbox: its content is emails from the product in folders. The server renders every
 * email's body into the page; the client shell (home-mailbox.tsx) shows one at a time and keeps the state.
 */

export type HomeFolderId = "inbox" | "features" | "deploy" | "cost" | "compare" | "limits" | "faq";
/** Starred is a view over every folder, not a folder of its own. */
export type HomeViewId = HomeFolderId | "starred";

export type HomeEmailMeta = {
	/** Also the deep link: /#<id> opens it. */
	id: string;
	folder: HomeFolderId;
	subject: string;
	/** The line under the subject in the list. */
	preview: string;
	/** Everything the email says, for the search box. */
	text: string;
};

export type HomePerson = { name: string; address: string; initial: string; own: boolean };

export type HomeMailboxProps = {
	appName: string;
	/** The brand icon (the install's custom one or the kite). */
	icon: string;
	emails: HomeEmailMeta[];
	bodies: Record<string, ReactNode>;
	/** The call-to-action buttons and account menu, rendered by the server page. */
	chrome: ReactNode;
	/** The attribution at the foot of the sidebar. */
	footer: ReactNode;
	/** Words in the headline, to set the Welcome subject in its two tones. */
	headline: string;
};

export type HomeMailboxState = {
	view: HomeViewId;
	openId: string | null;
	search: string;
	read: string[];
	starred: string[];
	menuOpen: boolean;
	/** Which pane a phone shows; wider screens show the list and the reader. */
	pane: "list" | "reader";
	composer: { to: string; subject: string } | null;
	toast: string | null;
	contactCard: { address: string; left: number } | null;
};

export type HomeMailboxAction =
	| { type: "open"; id: string }
	| {
			type: "view";
			view: HomeViewId;
			/** Below the md breakpoint the folder opens as a list, so its first email is not displayed. */ phone?: boolean;
	  }
	| { type: "search"; text: string }
	| { type: "star"; id: string }
	| { type: "back" }
	| { type: "toggleMenu" }
	| { type: "closeMenu" }
	| { type: "openContact"; address: string; left: number }
	| { type: "closeContact" }
	| { type: "compose"; to: string; subject: string }
	| { type: "closeComposer" }
	| { type: "send" }
	| { type: "toast"; text: string }
	| { type: "dismissToast" }
	| { type: "move"; direction: 1 | -1 };
