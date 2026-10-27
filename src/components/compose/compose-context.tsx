"use client";

import { createContext, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Where the open composer shows: the floating window, or docked in the reader under the message (Zero's reply). */
export type ComposePlacement = "popup" | "inline";
/** What a docked draft is, so the reply box under a message resumes only a reply. */
export type InlineDraftKind = "reply" | "forward";
type CollapsedDraft = { messageId: string; draftId: string; kind: InlineDraftKind };

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	placement: ComposePlacement;
	/** With an inline placement, the open message whose reader hosts the composer. */
	inlineFor: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string, options?: { inlineFor?: string | null; kind?: InlineDraftKind }) => void;
	/** Moves the open draft from the reader into the floating composer. */
	popOut: () => void;
	closeComposer: () => void;
	/** Closes a docked reply but remembers its draft, so the reply box under that message resumes it. */
	collapseInline: () => void;
	/** The docked reply last collapsed with Esc or Close, by the message it answers. */
	collapsed: CollapsedDraft | null;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	const [placement, setPlacement] = useState<ComposePlacement>("popup");
	const [inlineFor, setInlineFor] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<CollapsedDraft | null>(null);
	const [inlineKind, setInlineKind] = useState<InlineDraftKind>("reply");
	const opener = useRef<HTMLElement | null>(null);

	function rememberOpener() {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}

	function close() {
		setOpen(false);
		setDraftId(null);
		setPlacement("popup");
		setInlineFor(null);
		const previous = opener.current;
		opener.current = null;
		if (previous)
			requestAnimationFrame(() => {
				if (previous.isConnected) previous.focus();
			});
	}

	return (
		<ComposeContext.Provider
			value={{
				open,
				collapsed,
				draftId,
				placement,
				inlineFor,
				openComposer: () => {
					if (!open) rememberOpener();
					setDraftId(null);
					setPlacement("popup");
					setInlineFor(null);
					setOpen(true);
				},
				openDraftComposer: (nextDraftId, options) => {
					if (!open) rememberOpener();
					if (collapsed?.draftId === nextDraftId) setCollapsed(null);
					setDraftId(nextDraftId);
					setPlacement(options?.inlineFor ? "inline" : "popup");
					setInlineFor(options?.inlineFor ?? null);
					setInlineKind(options?.kind ?? "reply");
					setOpen(true);
				},
				popOut: () => {
					setPlacement("popup");
					setInlineFor(null);
				},
				closeComposer: () => {
					if (placement === "inline") setCollapsed(null);
					close();
				},
				collapseInline: () => {
					if (placement === "inline" && inlineFor && draftId)
						setCollapsed({ messageId: inlineFor, draftId, kind: inlineKind });
					close();
				},
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}
