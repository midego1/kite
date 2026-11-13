"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyChanged } from "@/hooks/use-synced-state";
import type { ConversationNote, ConversationNotesAnswer } from "@/lib/notes/notes-types";
import { t } from "@/lib/i18n/translator";
import type { ConversationNotesController } from "./conversation-notes-types";
import { notesUrl, noteUrl } from "./conversation-notes-utils";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The notes of the open conversation: loaded with the reader (no count until then), reloaded when the window
 * regains focus or mail changes (`kite:messages-changed`), so a colleague's note shows up without a reload. The
 * band opens by itself when the conversation has notes; answers for a message the reader left are dropped.
 */
export function useConversationNotes(messageId: string): ConversationNotesController {
	const [notes, setNotes] = useState<ConversationNote[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [canWrite, setCanWrite] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const [open, setOpen] = useState<boolean | null>(null);
	const [composeRequest, setComposeRequest] = useState(0);
	const [refresh, setRefresh] = useState(0);
	const shown = useRef(messageId);
	if (useKeyChanged(messageId)) {
		setNotes([]);
		setLoaded(false);
		setCanWrite(false);
		setUnavailable(false);
		setOpen(null);
		setComposeRequest(0);
	}

	useEffect(() => {
		const bump = () => setRefresh((value) => value + 1);
		window.addEventListener("kite:messages-changed", bump);
		window.addEventListener("focus", bump);
		return () => {
			window.removeEventListener("kite:messages-changed", bump);
			window.removeEventListener("focus", bump);
		};
	}, []);

	useEffect(() => {
		shown.current = messageId;
		let live = true;
		void fetch(notesUrl(messageId), { cache: "no-store" })
			.then((response) => (response.ok ? (response.json() as Promise<ConversationNotesAnswer>) : null))
			.then((answer) => {
				if (!live) return;
				setLoaded(true);
				if (!answer) return;
				setNotes(answer.notes);
				setCanWrite(answer.canWrite);
				setUnavailable(!!answer.migrationPending);
			})
			.catch(() => {
				if (live) setLoaded(true);
			});
		return () => {
			live = false;
		};
	}, [messageId, refresh]);

	/** Runs a write for the conversation shown now; null when it worked, else the sentence to show. */
	const write = useCallback(
		async (url: string, init: RequestInit, failed: string, apply: (body: { note?: ConversationNote }) => void) => {
			const key = messageId;
			try {
				const response = await fetch(url, init);
				if (shown.current !== key) return null;
				if (!response.ok) return failed;
				apply((await response.json().catch(() => ({}))) as { note?: ConversationNote });
				return null;
			} catch {
				return failed;
			}
		},
		[messageId],
	);

	const add = (body: string, aboutMessage: boolean) =>
		write(
			notesUrl(messageId),
			{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ body, aboutMessage }) },
			t("The note could not be saved. Try again."),
			({ note }) => {
				if (note) setNotes((current) => [...current, note]);
			},
		);
	const update = (noteId: string, body: string) =>
		write(
			noteUrl(messageId, noteId),
			{ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ body }) },
			t("The note could not be saved. Try again."),
			({ note }) => {
				if (note) setNotes((current) => current.map((item) => (item.id === noteId ? note : item)));
			},
		);
	const remove = (noteId: string) =>
		write(noteUrl(messageId, noteId), { method: "DELETE" }, t("The note could not be deleted. Try again."), () =>
			setNotes((current) => current.filter((item) => item.id !== noteId)),
		);

	// Until someone toggles it, the band is open exactly when there is something to read.
	const isOpen = open ?? notes.length > 0;
	return {
		messageId,
		notes,
		loaded,
		canWrite,
		unavailable,
		open: isOpen,
		composeRequest,
		toggle: () => setOpen(!isOpen),
		compose: () => {
			setOpen(true);
			setComposeRequest((value) => value + 1);
		},
		close: () => setOpen(false),
		add,
		update,
		remove,
	};
}
