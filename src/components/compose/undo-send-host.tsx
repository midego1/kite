"use client";

import { useSyncExternalStore } from "react";
import toast from "react-hot-toast";
import { authFetch } from "@/lib/auth/client";
import { useCompose } from "./compose-context";
import { UndoSendBar } from "./undo-send-bar";
import type { PendingUndoSend } from "./undo-send-types";

/*
 * Sending closes the composer, so the "Sending in …s" bar cannot belong to it: this module holds the bar of the
 * message in its undo window, and UndoSendHost (next to FloatingComposer) shows it. Undo takes the message back as a
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

export function UndoSendHost() {
	const { openDraftComposer } = useCompose();
	const held = useSyncExternalStore(
		subscribe,
		() => pending,
		() => null,
	);

	async function undo(target: PendingUndoSend) {
		setPending(null);
		try {
			const res = await authFetch("/api/send/undo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId: target.messageId }),
			});
			const data = (await res.json()) as { draftId?: string; error?: string };
			if (!res.ok || !data.draftId) {
				toast.error(data.error ?? "Could not undo send");
				return;
			}
			openDraftComposer(data.draftId);
			toast.success("Sending undone");
		} catch {
			toast.error("Could not undo send");
		}
		window.dispatchEvent(new Event("kite:messages-changed"));
	}

	if (!held) return null;
	return (
		<UndoSendBar
			pending={held}
			onUndo={() => void undo(held)}
			onExpire={(result) => {
				setPending(null);
				if (result) (result.type === "error" ? toast.error : toast.success)(result.message);
			}}
		/>
	);
}
