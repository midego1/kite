"use client";

import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { authFetch } from "@/lib/auth/client";
import { createDraftSaveQueue, withoutAttachmentIds } from "./draft-autosave-utils";
import type { ComposeAttachment, ComposeDraftSnapshot, ComposeStoredAttachment } from "./types";

const AUTOSAVE_DELAY_MS = 900;

type AutosaveSetters = {
	setDraftId: (draftId: string) => void;
	setAttachments: Dispatch<SetStateAction<ComposeAttachment[]>>;
	setStoredAttachments: Dispatch<SetStateAction<ComposeStoredAttachment[]>>;
	reportError: (toast: { type: "error"; message: string }) => void;
};

/** Composer files the autosave already tried to store on the draft, and those it stored. */
type DraftUploads = { tried: Set<string>; stored: Set<string> };

/**
 * Saves the composer to its draft 900 ms after the last change, one save at a
 * time, and stores the composer's files on the draft. A change still waiting
 * when the composer unmounts is saved then instead of being dropped. A
 * snapshot equal to what the last save stored is not saved again, and nothing
 * is saved while `paused` (a send review is open).
 *
 * The setters must be stable (React state setters): the save queue keeps the
 * ones from the first render.
 */
export function useDraftAutosave(
	snapshot: ComposeDraftSnapshot | null,
	setters: AutosaveSetters,
	{ paused = false }: { paused?: boolean } = {},
) {
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The debounced save not started yet; it still runs if the composer closes first.
	const pendingSave = useRef<ComposeDraftSnapshot | null>(null);
	const [{ draftSaves, uploads, lastSaved }] = useState(() => {
		const created: DraftUploads = { tried: new Set(), stored: new Set() };
		// The draft and content the last save stored; a snapshot that would write the same again is not saved.
		const lastSaved: { key: string | null } = { key: null };
		return {
			uploads: created,
			lastSaved,
			draftSaves: createDraftSaveQueue<ComposeDraftSnapshot>({
				save: async (next, existingId, stale) => {
					const saved = await saveDraftSnapshot(next, existingId, stale, created, setters);
					if (saved && !stale()) lastSaved.key = autosaveKey(saved, next);
					return saved;
				},
				discard: (id) => void authFetch(`/api/drafts/${id}`, { method: "DELETE" }).catch(() => {}),
				onDraftId: setters.setDraftId,
			}),
		};
	});

	useEffect(() => {
		// A save while a send review is open would change the draft under the review and void it.
		const next = snapshot && !paused && autosaveKey(draftSaves.draftId, snapshot) !== lastSaved.key ? snapshot : null;
		pendingSave.current = next;
		if (!next) return;
		const timer = setTimeout(() => {
			pendingSave.current = null;
			void draftSaves.enqueue(next);
		}, AUTOSAVE_DELAY_MS);
		saveTimer.current = timer;
		return () => clearTimeout(timer);
	}, [draftSaves, lastSaved, paused, snapshot]);

	// Closing the composer (or opening another draft) unmounts it; save what was typed in the last moment.
	useEffect(() => {
		const pending = pendingSave;
		return () => {
			const last = pending.current;
			pending.current = null;
			if (last) void draftSaves.enqueue(last);
		};
	}, [draftSaves]);

	return {
		draftSaves,
		/** Composer files already stored on the draft, which a send must not upload again. */
		storedUploads: uploads.stored as ReadonlySet<string>,
		/** Saves what is still waiting for the debounce now and resolves once every save has finished. */
		flush(): Promise<void> {
			if (saveTimer.current) clearTimeout(saveTimer.current);
			const last = pendingSave.current;
			pendingSave.current = null;
			return last ? draftSaves.enqueue(last) : draftSaves.idle();
		},
		/** Drops the debounced save that has not started; sending and deleting do not want it. */
		cancelPendingSave() {
			if (saveTimer.current) clearTimeout(saveTimer.current);
			pendingSave.current = null;
		},
	};
}

/** What a save of `snapshot` to `draftId` would store: the payload, and the files only when it stores them. */
function autosaveKey(draftId: string | null, snapshot: ComposeDraftSnapshot): string {
	const files = snapshot.storeAttachments ? snapshot.attachments.map((attachment) => attachment.id) : [];
	return JSON.stringify([draftId, snapshot.payload, files]);
}

async function saveDraftSnapshot(
	next: ComposeDraftSnapshot,
	existingId: string | null,
	stale: () => boolean,
	uploads: DraftUploads,
	setters: AutosaveSetters,
): Promise<string | null> {
	const res = await authFetch(existingId ? `/api/drafts/${existingId}` : "/api/drafts", {
		method: existingId ? "PATCH" : "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(next.payload),
	});
	const data = (await res.json().catch(() => ({}))) as { draft?: { id: string } };
	const savedId = res.ok ? (data.draft?.id ?? null) : null;
	if (savedId && next.storeAttachments && !stale())
		await storeDraftAttachments(savedId, next.attachments, uploads, setters);
	return savedId;
}

async function storeDraftAttachments(
	draftId: string,
	files: ComposeAttachment[],
	uploads: DraftUploads,
	setters: AutosaveSetters,
) {
	const pending = withoutAttachmentIds(files, uploads.tried);
	if (pending.length === 0) return;
	for (const attachment of pending) uploads.tried.add(attachment.id);
	const form = new FormData();
	for (const attachment of pending) form.append("attachments", attachment.file);
	let retryable = true;
	try {
		const res = await authFetch(`/api/drafts/${draftId}/attachments`, { method: "POST", body: form });
		retryable = res.status === 408 || res.status === 429 || res.status >= 500;
		const result = (await res.json().catch(() => ({}))) as { attachments?: ComposeStoredAttachment[]; error?: string };
		if (!res.ok) throw new Error(result.error || "the server refused them");
		const stored = new Set(pending.map((attachment) => attachment.id));
		for (const attachmentId of stored) uploads.stored.add(attachmentId);
		setters.setStoredAttachments((current) => [...current, ...(result.attachments ?? [])]);
		setters.setAttachments((current) => withoutAttachmentIds(current, stored));
	} catch (cause) {
		if (retryable) for (const attachment of pending) uploads.tried.delete(attachment.id);
		// Files the draft could not keep stay in the composer and go out with the send request.
		const reason = cause instanceof Error && cause.message ? cause.message : "the request failed";
		setters.reportError({
			type: "error",
			message: `Could not save the attachments with the draft (${reason}). They will still be sent.`,
		});
	}
}
