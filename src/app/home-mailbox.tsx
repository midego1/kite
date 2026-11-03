"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type KeyboardEvent } from "react";
import { HomeList } from "./home-mailbox-list";
import { HomeComposer, HomeToast } from "./home-mailbox-overlays";
import { HomeReader } from "./home-mailbox-reader";
import { HomeSidebar } from "./home-mailbox-sidebar";
import { createMailboxState, emailFromHash, reduceMailbox, WELCOME_ID } from "./home-mailbox-state-utils";
import type { HomeMailboxAction, HomeMailboxProps, HomePerson } from "./home-mailbox-types";

const TOAST_MS = 5000;
/** The contact card is 20rem wide, or the whole chip row when that is narrower. */
const CARD_WIDTH = 320;

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
	const mounted = useRef(false);
	const dispatch = useCallback((action: HomeMailboxAction) => {
		origin.current = "user";
		rawDispatch(action);
	}, []);
	const readerRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const contactOpener = useRef<HTMLElement | null>(null);
	const composerOpener = useRef<HTMLElement | null>(null);

	const mailbox = useMemo(() => ({ name: "You", address: "you@yourdomain.example" }), []);
	const people = useMemo<{ sender: HomePerson; me: HomePerson }>(() => {
		const slug = appName.toLowerCase().replace(/[^a-z0-9]/g, "") || "kite";
		return {
			sender: { name: appName, address: `hello@${slug}.example`, initial: appName.charAt(0).toUpperCase(), own: false },
			me: { name: "You", address: mailbox.address, initial: "Y", own: true },
		};
	}, [appName, mailbox.address]);

	// The hash names the open email: applied once on load and again on every Back, Forward or typed change.
	useLayoutEffect(() => {
		const apply = () => {
			origin.current = "hash";
			rawDispatch({ type: "open", id: emailFromHash(window.location.hash, emails) });
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
	}, [state.toast]);

	// The composer and the contact card take the focus when they open and give it back when they close.
	const composerOpen = !!state.composer;
	useEffect(() => {
		if (composerOpen) {
			composerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			rootRef.current?.querySelector<HTMLElement>('[aria-label="New message"] input')?.focus();
		} else if (
			composerOpener.current?.isConnected &&
			(!document.activeElement || document.activeElement === document.body)
		) {
			composerOpener.current.focus();
		}
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

	const copyLink = useCallback(async (id: string) => {
		const url = `${window.location.origin}${window.location.pathname}#${id}`;
		try {
			await navigator.clipboard.writeText(url);
			dispatch({ type: "toast", text: "Link copied" });
		} catch {
			dispatch({ type: "toast", text: "Could not copy the link" });
		}
	}, []);

	const openContact = useCallback((person: HomePerson, chip: HTMLElement) => {
		const item = chip.closest("li");
		const row = item?.parentElement;
		const left = item && row ? Math.max(0, Math.min(item.offsetLeft, row.clientWidth - CARD_WIDTH)) : 0;
		contactOpener.current = chip;
		dispatch({ type: "openContact", address: person.address, left });
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			const action: HomeMailboxAction | null = state.contactCard
				? { type: "closeContact" }
				: state.composer
					? { type: "closeComposer" }
					: state.menuOpen
						? { type: "closeMenu" }
						: null;
			if (action) {
				event.preventDefault();
				dispatch(action);
			}
			return;
		}
		const target = event.target as HTMLElement;
		if (target.closest("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "j" || event.key === "k") {
			event.preventDefault();
			dispatch({ type: "move", direction: event.key === "j" ? 1 : -1 });
		}
	};

	const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
		// A click outside an open card closes it; a click on a chip is handled by the chip.
		if (state.contactCard && !(event.target as HTMLElement).closest("[data-contact-card], [aria-haspopup='dialog']")) {
			dispatch({ type: "closeContact" });
		}
	};

	return (
		<div
			ref={rootRef}
			onKeyDown={onKeyDown}
			onClick={onClick}
			className="home-page relative flex h-dvh flex-col overflow-hidden bg-white text-neutral-900"
		>
			{/* Targets the open email's article (each is focusable), so it skips the folders and the list, and the
			    hash it sets always names an email, never a fragment the hash listener would read as Welcome. */}
			<a
				href={`#${state.openId ?? WELCOME_ID}`}
				className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900 focus:shadow"
			>
				Skip to the message
			</a>
			<div className="shrink-0 border-b border-neutral-200 bg-white">{chrome}</div>
			<main
				id="main"
				className="relative grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:grid-cols-[232px_minmax(300px,360px)_minmax(0,1fr)]"
			>
				<HomeSidebar state={state} emails={emails} dispatch={dispatch} mailbox={mailbox} footer={footer} />
				<HomeList state={state} emails={emails} appName={appName} icon={icon} onOpen={openEmail} dispatch={dispatch} />
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
				/>
				<HomeToast state={state} dispatch={dispatch} />
				{/* Remount for a new target: the To and Subject inputs are uncontrolled (defaultValue). */}
				<HomeComposer
					key={state.composer ? `${state.composer.to}\n${state.composer.subject}` : "closed"}
					state={state}
					dispatch={dispatch}
				/>
			</main>
		</div>
	);
}
