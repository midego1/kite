"use client";

import { useSyncExternalStore } from "react";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/auth/client";
import { useCompose } from "./compose-context";
import { UndoSendBar } from "./undo-send-bar";
import type { PendingUndoSend } from "./undo-send-types";

/*
 * Sending closes the composer, so the "Sending in …s" bar cannot belong to it: this module holds the bar of the
 * message in its undo window, and UndoSendHost (rendered by FloatingComposer) shows it. Undo takes the message back as a
 * draft and opens it in the composer again, with everything it had.
 */
let pending: PendingUndoSend | null = null;
const listeners = new Set<() => void>();

function setPending(next: PendingUndoSend | null) {
	pending = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Hands the undo bar of a message just sent to the host, so it outlives the composer that sent it. */
export function beginUndoSend(held: PendingUndoSend) {
	setPending(held);
}

/** Drops the bar of `target`, unless a newer send has taken its place meanwhile. */
function clear(target: PendingUndoSend) {
	if (pending?.messageId === target.messageId) setPending(null);
}

/** One Undo request at a time, so a double click cannot ask twice. */
let undoing = false;

export function UndoSendHost() {
	const { openDraftComposer } = useCompose();
	const held = useSyncExternalStore(
		subscribe,
		() => pending,
		() => null,
	);

	// The bar stays up while the request runs, so a failure that leaves the message held keeps its Undo, Send now and
	// whatever state the bar was in; only an answer that says the message is gone or already out removes it.
	async function undo(target: PendingUndoSend) {
		if (undoing) return;
		undoing = true;
		try {
			const res = await authFetch("/api/send/undo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId: target.messageId }),
			});
			const data = (await res.json()) as { draftId?: string; error?: string };
			if (!res.ok || !data.draftId) {
				if (res.status === 404 || res.status === 409) clear(target);
				toast.error(data.error ?? "Could not undo send");
				return;
			}
			clear(target);
			openDraftComposer(data.draftId);
			toast.success("Sending undone");
			window.dispatchEvent(new Event("kite:messages-changed"));
		} catch {
			toast.error("Could not undo send");
		} finally {
			undoing = false;
		}
	}

	if (!held) return null;
	return (
		<UndoSendBar
			key={held.messageId}
			pending={held}
			onUndo={() => void undo(held)}
			onExpire={(result) => {
				clear(held);
				if (result) (result.type === "error" ? toast.error : toast.success)(result.message);
			}}
		/>
	);
}
