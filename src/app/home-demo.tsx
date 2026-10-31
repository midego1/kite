"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { DemoFrame } from "./home-demo-frame";
import { actionFromDataset, createDemoState, reduceDemo } from "./home-demo-state-utils";
import type { DemoAction, DemoClick, DemoState, HomeDemoProps } from "./home-demo-types";

const TOAST_MS = 6000;
const OPENS_DIALOG: DemoAction["type"][] = ["reply", "takeSuggestion", "toggleChat"];

function initialState(click: DemoClick | null | undefined): DemoState {
	const state = createDemoState();
	const action = click ? actionFromDataset(click) : null;
	return action ? reduceDemo(state, action) : state;
}

/** Escape closes whatever is on top: the composer, the chat, the phone menu, then the open message. */
function escapeAction(state: DemoState): DemoAction | null {
	if (state.composer) return { type: "closeComposer" };
	if (state.chatOpen) return { type: "toggleChat" };
	if (state.menuOpen) return { type: "toggleMenu" };
	if (state.openId) return { type: "close" };
	return null;
}

function focusWithin(root: HTMLElement | null, selector: string) {
	root?.querySelector<HTMLElement>(selector)?.focus();
}

/**
 * The live demo: the frame with local state. Buttons carry `data-action`, so one click handler on the root
 * serves every part, and j, k and Escape work while the focus is anywhere inside the frame. The composer
 * and the chat take the focus when they open and give it back to the button that opened them.
 */
export function HomeDemo({ appName, initialAction }: HomeDemoProps) {
	const [state, dispatch] = useReducer(reduceDemo, initialAction, initialState);
	const [chatInput, setChatInput] = useState("");
	const root = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const dialogWasOpen = useRef(false);
	const dialogOpen = !!state.composer || state.chatOpen;

	useEffect(() => {
		if (!state.toast) return;
		const timer = window.setTimeout(() => dispatch({ type: "dismissToast" }), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [state.toast]);

	useEffect(() => {
		if (state.composer) focusWithin(root.current, '[role="dialog"][aria-label="New message"] input');
	}, [state.composer]);

	useEffect(() => {
		if (state.chatOpen) focusWithin(root.current, '[role="dialog"] form input');
	}, [state.chatOpen]);

	useEffect(() => {
		if (dialogWasOpen.current && !dialogOpen) {
			if (opener.current?.isConnected) opener.current.focus();
			else focusWithin(root.current, '[aria-current="true"], [data-action="open"]');
		}
		dialogWasOpen.current = dialogOpen;
	}, [dialogOpen]);

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
		if (!button || !event.currentTarget.contains(button)) return;
		const action = actionFromDataset(button.dataset);
		if (!action) return;
		if (OPENS_DIALOG.includes(action.type) && !dialogOpen) opener.current = button;
		dispatch(action);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			const action = escapeAction(state);
			if (action) {
				event.preventDefault();
				dispatch(action);
			}
			return;
		}
		const inField = !!(event.target as HTMLElement).closest("input, textarea");
		if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "j" || event.key === "k") {
			event.preventDefault();
			dispatch({ type: "move", direction: event.key === "j" ? 1 : -1 });
		}
	};

	const onChatSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		dispatch({ type: "chatSend", text: chatInput });
		setChatInput("");
	};

	return (
		<DemoFrame
			state={state}
			live
			appName={appName}
			rootRef={root}
			onClick={onClick}
			onKeyDown={onKeyDown}
			onSearch={(text) => dispatch({ type: "search", text })}
			chatInput={chatInput}
			onChatInput={setChatInput}
			onChatSubmit={onChatSubmit}
		/>
	);
}
