import { useEffect, useEffectEvent } from "react";

/**
 * Opens the assistant panel on a specific conversation (the deep link an assistant-by-email reply carries,
 * `?assistant=<conversationId>` on any dashboard path, spec §8.4). The id waits in session storage the same way
 * `assistant-prompt-request.ts` hands over a prepared question, so it survives the move from a redirected sign-in
 * back to the original URL. Taken once; a stale id nobody took is simply overwritten by the next deep link.
 */
const STORAGE_KEY = "kite:assistant-conversation";
const ASSISTANT_CONVERSATION_EVENT = "kite:assistant-conversation";

function requestAssistantConversation(conversationId: string) {
	try {
		sessionStorage.setItem(STORAGE_KEY, conversationId);
	} catch {
		return;
	}
	window.dispatchEvent(new Event(ASSISTANT_CONVERSATION_EVENT));
}

function takeAssistantConversation(): string | null {
	try {
		const id = sessionStorage.getItem(STORAGE_KEY);
		if (id !== null) sessionStorage.removeItem(STORAGE_KEY);
		return id;
	} catch {
		return null;
	}
}

/** Reads `?assistant=<conversationId>` off the current URL once, strips it, and hands it over. True if one was there. */
export function consumeAssistantConversationParam(): boolean {
	let url: URL;
	try {
		url = new URL(window.location.href);
	} catch {
		return false;
	}
	const id = url.searchParams.get("assistant");
	if (!id) return false;
	url.searchParams.delete("assistant");
	window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
	requestAssistantConversation(id);
	return true;
}

/** The panel's side: while it is open on a mailbox, a waiting conversation id (now or when one arrives) opens it. */
export function useRequestedAssistantConversation(
	open: boolean,
	mailboxId: string | null | undefined,
	selectConversation: (id: string) => void,
) {
	const ready = open && !!mailboxId;
	const take = useEffectEvent(() => {
		const id = takeAssistantConversation();
		if (id !== null) selectConversation(id);
	});
	useEffect(() => {
		if (!ready) return;
		take();
		const onRequest = () => take();
		window.addEventListener(ASSISTANT_CONVERSATION_EVENT, onRequest);
		return () => window.removeEventListener(ASSISTANT_CONVERSATION_EVENT, onRequest);
	}, [ready]);
}
