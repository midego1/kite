"use client";

import { createContext, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Where the open composer shows: the floating window, or docked in the reader under the message (Zero's reply). */
export type ComposePlacement = "popup" | "inline";
/** What a docked draft is, so `r`, `a`, `f` and the reply box resume only a draft of their own kind. */
export type InlineDraftKind = "reply" | "replyAll" | "forward";
/** A collapsed docked draft: the reader it was docked in, the message it answers and what it is. */
type CollapsedDraft = { messageId: string; draftId: string; kind: InlineDraftKind; source: string | null };
type InlineOptions = { inlineFor?: string | null; kind?: InlineDraftKind; source?: string | null };
/** The element under the open message where the docked composer is shown (inline-reply-composer.tsx). */
export type InlineSlot = { messageId: string; element: HTMLElement };

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	placement: ComposePlacement;
	/** With an inline placement, the open message whose reader hosts the composer. */
	inlineFor: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string, options?: InlineOptions) => void;
	/** Moves the docked draft (by default the one it opened with) into the floating composer. */
	popOut: (draftId?: string | null) => void;
	closeComposer: () => void;
	/** Closes a docked reply but remembers its draft, so the reply box under that message resumes it. */
	collapseInline: (draftId?: string | null) => void;
	/** Closes a docked reply whose draft is gone (sent or deleted), so nothing offers to resume it. */
	finishInline: (draftId?: string | null) => void;
	/** The docked reply last collapsed with Esc or Close, by the message it answers. */
	collapsed: CollapsedDraft | null;
	inlineSlot: InlineSlot | null;
	setInlineSlot: (slot: InlineSlot | null) => void;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

/** The reply box under the open message, which takes the focus back when a docked reply closes. */
const REPLY_BOX_SELECTOR = "[data-reply-box]";

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	const [placement, setPlacement] = useState<ComposePlacement>("popup");
	const [inlineFor, setInlineFor] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<CollapsedDraft | null>(null);
	const [inlineKind, setInlineKind] = useState<InlineDraftKind>("reply");
	const [inlineSource, setInlineSource] = useState<string | null>(null);
	const [inlineSlot, setInlineSlot] = useState<InlineSlot | null>(null);
	const opener = useRef<HTMLElement | null>(null);

	function rememberOpener() {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}

	function close() {
		const wasInline = placement === "inline";
		setOpen(false);
		setDraftId(null);
		setPlacement("popup");
		setInlineFor(null);
		const previous = opener.current;
		opener.current = null;
		requestAnimationFrame(() => {
			// A docked reply gives the focus to the reply box that replaces it.
			const replyBox = wasInline ? document.querySelector<HTMLElement>(REPLY_BOX_SELECTOR) : null;
			if (replyBox) replyBox.focus();
			else if (previous?.isConnected) previous.focus();
		});
	}

	function forget(...ids: (string | null | undefined)[]) {
		setCollapsed((current) => (current && ids.includes(current.draftId) ? null : current));
	}

	return (
		<ComposeContext.Provider
			value={{
				open,
				collapsed,
				draftId,
				placement,
				inlineFor,
				inlineSlot,
				setInlineSlot,
				openComposer: () => {
					if (!open) rememberOpener();
					setDraftId(null);
					setPlacement("popup");
					setInlineFor(null);
					setOpen(true);
				},
				openDraftComposer: (nextDraftId, options) => {
					if (!open) rememberOpener();
					// A docked reply that another one replaces stays resumable from its reply box.
					if (open && placement === "inline" && inlineFor && draftId && draftId !== nextDraftId)
						setCollapsed({ messageId: inlineFor, draftId, kind: inlineKind, source: inlineSource });
					else forget(nextDraftId);
					setDraftId(nextDraftId);
					setPlacement(options?.inlineFor ? "inline" : "popup");
					setInlineFor(options?.inlineFor ?? null);
					setInlineKind(options?.kind ?? "reply");
					setInlineSource(options?.source ?? null);
					setOpen(true);
				},
				popOut: (poppedDraftId) => {
					forget(poppedDraftId, draftId);
					if (poppedDraftId) setDraftId(poppedDraftId);
					setPlacement("popup");
					setInlineFor(null);
				},
				closeComposer: () => {
					forget(draftId);
					close();
				},
				collapseInline: (collapsedDraftId) => {
					const id = collapsedDraftId ?? draftId;
					if (placement === "inline" && inlineFor && id)
						setCollapsed({ messageId: inlineFor, draftId: id, kind: inlineKind, source: inlineSource });
					close();
				},
				finishInline: (finishedDraftId) => {
					forget(finishedDraftId, draftId);
					close();
				},
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}
