"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type MouseEvent } from "react";
import { useFoldViewport } from "@/components/use-fold-posture";
import { hingeGrid, homeHinge } from "./home-mailbox-fold";
import { HomeList } from "./home-mailbox-list";
import { HomeComposer, HomeToast } from "./home-mailbox-overlays";
import { HomeReader } from "./home-mailbox-reader";
import { HomeSidebar } from "./home-mailbox-sidebar";
import { createMailboxState, emailFromHash, reduceMailbox, WELCOME_ID } from "./home-mailbox-state-utils";
import type { HomeMailboxAction, HomeMailboxProps, HomeMailboxState, HomePerson } from "./home-mailbox-types";

const TOAST_MS = 5000;
const NO_JS_CSS =
	'main{display:block!important;overflow:hidden}[data-home-pane="folders"],[data-home-pane="list"],[data-home-toolbar]{display:none!important}[data-home-pane="reader"]{display:flex!important;height:100%}article[data-open]{display:block!important}article+article{border-top:1px solid rgb(128 128 128 / .3);padding-top:1.5rem;margin-top:1.5rem}';
/** The contact card is 20rem wide, or the whole chip row when that is narrower. */
const CARD_WIDTH = 320;

/** Escape closes whatever is on top: the contact card, the composer, then the menu. */
function escapeAction(state: HomeMailboxState): HomeMailboxAction | null {
	if (state.contactCard) return { type: "closeContact" };
	if (state.composer) return { type: "closeComposer" };
	return state.menuOpen ? { type: "closeMenu" } : null;
}

/** A key meant for a field, or a shortcut of the browser, is never the mailbox's. */
function isTyping(event: KeyboardEvent): boolean {
	const target = event.target as HTMLElement | null;
	return (
		!!target?.closest("input, textarea, select, [contenteditable='true']") ||
		event.metaKey ||
		event.ctrlKey ||
		event.altKey
	);
}

/** An overlay menu holds Tab: below lg always, and on a foldable at any width, where the menu only ever overlays. */
function trapTab(event: KeyboardEvent, root: HTMLElement | null, overlay: boolean) {
	if (!overlay && window.matchMedia("(min-width: 1024px)").matches) return;
	const items = [...(root?.querySelectorAll<HTMLElement>('aside[aria-label="Folders"] :is(button, a[href])') ?? [])];
	if (items.length === 0) return;
	const active = document.activeElement as HTMLElement | null;
	const inside = !!active && items.includes(active);
	const edge = items[event.shiftKey ? 0 : items.length - 1];
	if (!inside || active === edge) {
		event.preventDefault();
		items[event.shiftKey ? items.length - 1 : 0].focus();
	}
}

/**
 * After a move the focus follows the open email's row (or its article on a phone) when the element that had it is
 * gone; with neither on screen (a phone showing an empty list) it lands on the search field.
 */
function settleFocus(root: HTMLElement | null) {
	window.requestAnimationFrame(() => {
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected && !active.closest('[data-open="false"]')) return;
		const article = root?.querySelector<HTMLElement>('article[data-open="true"]');
		const row = root?.querySelector<HTMLElement>('[aria-current="true"]');
		const shown = (element: HTMLElement | null | undefined) =>
			element && element.getClientRects().length > 0 ? element : null;
		const target = shown(row) ?? shown(article) ?? root?.querySelector<HTMLElement>('input[type="search"]');
		target?.focus();
	});
}

/**
 * The home page: a full-viewport mailbox whose emails are the page's content. The page itself never scrolls;
 * the list and the reader scroll inside their panes. The URL hash names the open email (/#deploy), a click on
 * an email pushes it, and the browser's Back and Forward move between emails. Everything stays on this page.
 */
export function HomeMailbox({ appName, icon, emails, bodies, chrome, footer, headline }: HomeMailboxProps) {
	const [state, rawDispatch] = useReducer(
		(current: ReturnType<typeof createMailboxState>, action: HomeMailboxAction) =>
			reduceMailbox(current, action, emails),
		undefined,
		createMailboxState,
	);
	// Whether the open email last changed by a click or key (a new history entry) or by the URL (never a new entry).
	const origin = useRef<"user" | "hash">("user");
	const readerRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const contactOpener = useRef<HTMLElement | null>(null);
	const composerOpener = useRef<HTMLElement | null>(null);
	const stateRef = useRef(state);
	const menuOverlayRef = useRef(false);
	const wasMenuOpen = useRef(false);
	const wasComposerOpen = useRef(false);

	const mounted = useRef(false);
	const dispatch = useCallback((action: HomeMailboxAction) => {
		origin.current = "user";
		if (action.type === "compose") {
			// What had the focus when it opened gets it back on close; from the contact card that is its chip, as the
			// card's own button goes away with the card.
			const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			composerOpener.current = !active || active.closest("[data-contact-card]") ? contactOpener.current : active;
		}
		rawDispatch(action);
	}, []);

	const mailbox = useMemo(() => ({ name: "You", address: "you@yourdomain.example" }), []);
	const people = useMemo<{ sender: HomePerson; me: HomePerson }>(() => {
		const slug = appName.toLowerCase().replace(/[^a-z0-9]/g, "") || "kite";
		return {
			sender: {
				name: appName,
				address: `hello@${slug}.example`,
				initial: appName.charAt(0).toUpperCase(),
				own: false,
				brand: true,
			},
			me: { name: "You", address: mailbox.address, initial: "Y", own: true },
		};
	}, [appName, mailbox.address]);

	// The hash names the open email: applied once on load and again on every Back, Forward or typed change.
	useLayoutEffect(() => {
		const apply = () => {
			origin.current = "hash";
			const named = emailFromHash(window.location.hash, emails);
			// Back onto a denied example names mail that is gone: show Welcome and rewrite the URL to say so.
			const id = stateRef.current.denied.includes(named) ? WELCOME_ID : named;
			if (id !== named) window.history.replaceState(null, "", `#${id}`);
			rawDispatch({ type: "open", id });
		};
		if (window.location.hash) apply();
		window.addEventListener("hashchange", apply);
		return () => window.removeEventListener("hashchange", apply);
	}, [emails]);

	const openEmail = useCallback((id: string) => dispatch({ type: "open", id }), [dispatch]);

	// The URL follows the open email: a click adds a history entry, so Back returns to the one before; an email
	// the URL itself named only has an old anchor (/#faq) rewritten to its own.
	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			return;
		}
		const want = `#${state.openId}`;
		if (!state.openId || window.location.hash === want) return;
		if (origin.current === "hash") {
			if (window.location.hash) window.history.replaceState(null, "", want);
			return;
		}
		window.history.pushState(null, "", want);
	}, [state.openId]);

	// Marks the page as interactive, so tests and scripts know when a click will be heard.
	useEffect(() => {
		rootRef.current?.setAttribute("data-hydrated", "true");
	}, []);

	// A new email starts at its top.
	useEffect(() => {
		readerRef.current?.scrollTo({ top: 0 });
	}, [state.openId]);

	useEffect(() => {
		if (!state.toast) return;
		const timer = window.setTimeout(() => dispatch({ type: "dismissToast" }), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [state.toast, dispatch]);

	// The composer and the contact card take the focus when they open and give it back when they close.
	const composerOpen = !!state.composer;
	useEffect(() => {
		if (composerOpen) {
			rootRef.current?.querySelector<HTMLElement>('[aria-label="New message"] input')?.focus();
		} else if (wasComposerOpen.current && (!document.activeElement || document.activeElement === document.body)) {
			// Only once it has been open: on load nothing is restored. The opener may be the menu's New email button, hidden again below lg: the menu's own button stands in.
			const opener = composerOpener.current;
			const shown = opener?.isConnected && opener.getClientRects().length > 0;
			(shown ? opener : rootRef.current?.querySelector<HTMLElement>('button[aria-label="Open menu"]'))?.focus();
		}
		wasComposerOpen.current = composerOpen;
	}, [composerOpen]);
	const cardOpen = !!state.contactCard;
	useEffect(() => {
		if (cardOpen) rootRef.current?.querySelector<HTMLElement>("[data-contact-card] button")?.focus();
		else if (
			contactOpener.current?.isConnected &&
			(!document.activeElement || document.activeElement === document.body)
		) {
			contactOpener.current.focus();
		}
	}, [cardOpen]);

	const copyLink = useCallback(
		async (id: string) => {
			const url = `${window.location.origin}${window.location.pathname}#${id}`;
			try {
				await navigator.clipboard.writeText(url);
				dispatch({ type: "toast", text: "Link copied" });
			} catch {
				dispatch({ type: "toast", text: "Could not copy the link" });
			}
		},
		[dispatch],
	);

	const openContact = useCallback((person: HomePerson, chip: HTMLElement) => {
		const item = chip.closest("li");
		const row = item?.parentElement;
		const left = item && row ? Math.max(0, Math.min(item.offsetLeft, row.clientWidth - CARD_WIDTH)) : 0;
		contactOpener.current = chip;
		rawDispatch({ type: "openContact", address: person.address, left });
	}, []);

	const fold = useFoldViewport();
	const hinge = homeHinge(fold);

	useEffect(() => {
		stateRef.current = state;
		// The menu overlays instead of being a column on a foldable, on a folded layout of any width and below lg.
		menuOverlayRef.current = !!hinge || fold.posture === "folded";
	});

	// Keys work from a fresh load, wherever the focus is, except in a field. After a move the focus follows the open
	// email's row (or the reader on a phone) when the element that had it has gone.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const current = stateRef.current;
			const root = rootRef.current;
			if (event.key === "Escape") {
				const action = escapeAction(current);
				if (action) {
					event.preventDefault();
					dispatch(action);
				}
			} else if (event.key === "Tab") {
				if (current.menuOpen) trapTab(event, root, menuOverlayRef.current);
			} else if ((event.key === "j" || event.key === "k") && !current.composer && !isTyping(event)) {
				event.preventDefault();
				dispatch({ type: "move", direction: event.key === "j" ? 1 : -1 });
				settleFocus(root);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [dispatch]);

	// The menu takes the focus when it opens and, when it closes, hands it back to the button that opened it.
	const menuOpen = state.menuOpen;
	useEffect(() => {
		if (menuOpen) {
			rootRef.current?.querySelector<HTMLElement>('aside[aria-label="Folders"] button')?.focus();
		} else if (
			wasMenuOpen.current &&
			(!document.activeElement ||
				document.activeElement === document.body ||
				document.activeElement.closest('aside[aria-label="Folders"]'))
		) {
			rootRef.current?.querySelector<HTMLElement>('button[aria-label="Open menu"]')?.focus();
		}
		wasMenuOpen.current = menuOpen;
	}, [menuOpen]);

	// An email counts as read once it is on screen: in the reader, or beside the list when the split shows it. A
	// cover screen, a phone held sideways and a window below the split variant's width floor show one pane, even
	// with a saved "Always two panes", so the posture alone is not enough; also when it is widened to show it.
	const twoPanes = fold.posture !== "folded" && fold.splitWidth;
	useEffect(() => {
		const current = stateRef.current;
		if (current.openId && (twoPanes || current.pane === "reader")) {
			rawDispatch({ type: "markRead", id: current.openId });
		}
	}, [state.openId, state.pane, twoPanes]);

	// Dismiss, Approve and Deny remove their own control: the focus goes to the open email's row or article, not to body.
	const decisions = state.dismissed.length + state.decided.length;
	const decisionsSeen = useRef(0);
	useEffect(() => {
		if (decisions > decisionsSeen.current) settleFocus(rootRef.current);
		decisionsSeen.current = decisions;
	}, [decisions]);

	// The skip link opens the open email for a phone too, where the list may be showing: the hash would not change.
	const skipToMessage = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		const id = stateRef.current.openId ?? WELCOME_ID;
		dispatch({ type: "open", id });
		window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`article[id="${id}"]`)?.focus());
	};

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		// A click outside an open card closes it; a click on a chip is handled by the chip.
		if (state.contactCard && !(event.target as HTMLElement).closest("[data-contact-card], [aria-haspopup='dialog']")) {
			dispatch({ type: "closeContact" });
		}
	};

	return (
		<div
			ref={rootRef}
			onClick={onClick}
			className="home-page relative flex h-dvh flex-col overflow-clip bg-white pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-neutral-900"
		>
			{/* Targets the open email's article (each is focusable), so it skips the folders and the list, and the
			    hash it sets always names an email, never a fragment the hash listener would read as Welcome. */}
			<a
				href={`#${state.openId ?? WELCOME_ID}`}
				onClick={skipToMessage}
				className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900 focus:shadow"
			>
				Skip to the message
			</a>
			{/* Without JavaScript the folders do nothing, so the page is one long reader with every email open. */}
			<noscript>
				<style>{NO_JS_CSS}</style>
			</noscript>
			<div className="shrink-0 border-b border-neutral-200 bg-white">{chrome}</div>
			<main
				id="main"
				style={hinge ? hingeGrid(hinge) : undefined}
				className="relative grid min-h-0 flex-1 grid-cols-1 split:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] split:lg:grid-cols-[232px_minmax(300px,360px)_minmax(0,1fr)]"
			>
				<HomeSidebar
					state={state}
					emails={emails}
					dispatch={dispatch}
					mailbox={mailbox}
					footer={footer}
					menuOnly={!!hinge}
				/>
				<HomeList
					state={state}
					emails={emails}
					appName={appName}
					icon={icon}
					onOpen={openEmail}
					dispatch={dispatch}
					menuOnly={!!hinge}
				/>
				<HomeReader
					ref={readerRef}
					state={state}
					emails={emails}
					bodies={bodies}
					people={people}
					icon={icon}
					headline={headline}
					dispatch={dispatch}
					onCopyLink={(id) => void copyLink(id)}
					onContact={openContact}
					secondScreen={!!hinge}
				/>
				<HomeToast state={state} dispatch={dispatch} secondScreen={!!hinge} />
				{/* Remount for a new target: the To and Subject inputs are uncontrolled (defaultValue). */}
				<HomeComposer
					key={state.composer ? `${state.composer.to}\n${state.composer.subject}\n${state.composer.body}` : "closed"}
					state={state}
					dispatch={dispatch}
					secondScreen={!!hinge}
				/>
			</main>
		</div>
	);
}
