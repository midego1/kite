"use client";

import { useEffect, useReducer, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { DemoFrame } from "./home-demo-frame";
import { actionFromDataset, createDemoState, reduceDemo } from "./home-demo-state-utils";
import type { DemoAction, DemoState, HomeDemoProps } from "./home-demo-types";

const TOAST_MS = 6000;

/** Escape closes whatever is on top: the composer, the chat, the phone menu, then the open message. */
function escapeAction(state: DemoState): DemoAction | null {
	if (state.composer) return { type: "closeComposer" };
	if (state.chatOpen) return { type: "toggleChat" };
	if (state.menuOpen) return { type: "toggleMenu" };
	if (state.openId) return { type: "close" };
	return null;
}

/**
 * The live demo: the frame with local state. Buttons carry `data-action`, so one click handler on the root
 * serves every part, and j, k and Escape work while the focus is inside the frame and not in a field.
 */
export function HomeDemo({ appName }: HomeDemoProps) {
	const [state, dispatch] = useReducer(reduceDemo, undefined, createDemoState);
	const [chatInput, setChatInput] = useState("");

	useEffect(() => {
		if (!state.toast) return;
		const timer = window.setTimeout(() => dispatch({ type: "dismissToast" }), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [state.toast]);

	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
		if (!button || !event.currentTarget.contains(button)) return;
		const action = actionFromDataset(button.dataset);
		if (action) dispatch(action);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const inField = !!(event.target as HTMLElement).closest("input, textarea");
		if (event.key === "Escape") {
			const action = escapeAction(state);
			if (action) {
				event.preventDefault();
				dispatch(action);
			}
			return;
		}
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
			onClick={onClick}
			onKeyDown={onKeyDown}
			onSearch={(text) => dispatch({ type: "search", text })}
			chatInput={chatInput}
			onChatInput={setChatInput}
			onChatSubmit={onChatSubmit}
		/>
	);
}
