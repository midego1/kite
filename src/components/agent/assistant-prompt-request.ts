import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { parseAssistantPrompt, serializeAssistantPrompt } from "./assistant-prompt-request-utils";

/**
 * Hands a prepared question to the assistant from anywhere: the text waits in session storage until the panel is
 * open and takes it, so it also survives the move from an admin page to the mailbox. The panel puts it in a new
 * chat's input and never sends it on its own. A question nobody took within `ASSISTANT_PROMPT_TTL_MS` (the move
 * failed, the tab was left) is dropped, so it never turns up in a chat opened much later.
 */
const STORAGE_KEY = "kite:assistant-prompt";
export const ASSISTANT_PROMPT_EVENT = "kite:assistant-prompt";

export function requestAssistantPrompt(text: string) {
	try {
		sessionStorage.setItem(STORAGE_KEY, serializeAssistantPrompt(text, Date.now()));
	} catch {
		return;
	}
	window.dispatchEvent(new Event(ASSISTANT_PROMPT_EVENT));
}

/** The waiting text if it is still fresh; an expired or unreadable entry is removed. Null when there is none. */
function readAssistantPrompt(): string | null {
	const stored = sessionStorage.getItem(STORAGE_KEY);
	if (stored === null) return null;
	const text = parseAssistantPrompt(stored, Date.now());
	if (text === null) sessionStorage.removeItem(STORAGE_KEY);
	return text;
}

export function hasAssistantPrompt(): boolean {
	try {
		return readAssistantPrompt() !== null;
	} catch {
		return false;
	}
}

/** The waiting text, removed so it is used once, or null. */
function takeAssistantPrompt(): string | null {
	try {
		const text = readAssistantPrompt();
		if (text !== null) sessionStorage.removeItem(STORAGE_KEY);
		return text;
	} catch {
		return null;
	}
}

/**
 * The panel's side: while it is open on a mailbox, a waiting question (now or when one arrives) starts a new chat
 * with the question in the input, unsent, and the input takes the focus once it is enabled.
 */
export function useRequestedAssistantPrompt(
	open: boolean,
	mailboxId: string | null | undefined,
	inputRef: RefObject<HTMLTextAreaElement | null>,
	startNewChat: () => void,
	setInput: (text: string) => void,
) {
	const focusWhenReady = useRef(false);
	const ready = open && !!mailboxId;
	const take = useEffectEvent(() => {
		const text = takeAssistantPrompt();
		if (text === null) return;
		startNewChat();
		setInput(text);
		focusWhenReady.current = true;
	});
	useEffect(() => {
		if (!ready) return;
		take();
		const onRequest = () => take();
		window.addEventListener(ASSISTANT_PROMPT_EVENT, onRequest);
		return () => window.removeEventListener(ASSISTANT_PROMPT_EVENT, onRequest);
	}, [ready]);
	// The input stays disabled until the panel's settings load, so this checks after every render.
	useEffect(() => {
		const field = inputRef.current;
		if (!focusWhenReady.current || !field || field.disabled) return;
		focusWhenReady.current = false;
		field.focus();
	});
}
