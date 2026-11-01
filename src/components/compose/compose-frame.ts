"use client";

import { useEffect, useRef } from "react";
import { useAssistantDocked } from "@/components/agent/assistant-open-state";
import type { ComposerZone } from "@/components/ui/toast-zone";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { cn } from "@/lib/utils";

type ComposeFrameState = {
	mode: "page" | "popup" | "inline";
	minimized: boolean;
	modalMode: boolean;
};

/**
 * Opening the assistant chat window tucks the popup composer away; the user can restore it beside the assistant.
 * Returns whether the composer currently docks next to the assistant.
 */
export function useComposerBesideAssistant(
	{ mode, minimized, modalMode }: ComposeFrameState,
	setMinimized: (minimized: boolean) => void,
) {
	const assistantDocked = useAssistantDocked() && mode === "popup";
	const changed = useKeyChanged(assistantDocked);
	if (changed && assistantDocked && !modalMode && !minimized) setMinimized(true);
	return assistantDocked;
}

function baseFrameClass({ mode, minimized, modalMode }: ComposeFrameState) {
	// Docked under the open message, as Zero's reply composer: a bordered card at the bottom of the reader. It does
	// not clip: Write with Kite's panel opens above the toolbar and may reach over the message (the editor scrolls).
	if (mode === "inline")
		return "relative mx-3 mb-3 flex h-[min(440px,55vh)] shrink-0 flex-col rounded-xl border border-neutral-200 bg-white shadow-sm sm:mx-6";
	if (mode !== "popup")
		return "relative flex h-full min-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm";
	if (minimized)
		return "fixed bottom-0 right-8 z-40 flex h-9 w-[min(260px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-lg border border-neutral-200 bg-white shadow-2xl";
	if (modalMode)
		return "fixed left-1/2 top-[calc(50%-2.5rem)] z-50 flex h-[min(86vh,calc(100vh-7rem))] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-white shadow-2xl";
	return "fixed bottom-0 right-8 z-40 flex h-[min(520px,calc(100vh-88px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-lg border border-neutral-200 bg-white shadow-2xl";
}

export function composeFrameClass(state: ComposeFrameState, besideAssistant: boolean) {
	return cn(
		baseFrameClass(state),
		// Mirrors the assistant window's right-8 and resizable width (floating-assistant-window.tsx), plus a 1rem gap.
		besideAssistant &&
			(state.minimized || !state.modalMode) &&
			"md:right-[calc(3rem+min(var(--assistant-window-width,440px),100vw-32px))]",
	);
}

/** Where notices must keep clear of the composer, for `useComposerZone`; none while it is minimized or docked in the reader. */
export function composerZone({ mode, minimized, modalMode }: ComposeFrameState): ComposerZone | null {
	if (mode === "page") return "page";
	if (mode !== "popup" || minimized) return null;
	return modalMode ? "modal" : "docked";
}

/** The popup is a labelled region, and a modal dialog while it is expanded. */
export function composeFrameAria({ mode, minimized, modalMode }: ComposeFrameState) {
	if (modalMode && !minimized) return { role: "dialog", "aria-modal": true, "aria-label": "Compose message" } as const;
	if (mode === "popup" || mode === "inline") return { role: "region", "aria-label": "Compose message" } as const;
	return {};
}

/** An opened draft or reply starts in the body; a new message starts in the recipients field (its `autoFocus`). */
export function useDraftBodyFocus(draftIdToLoad: string | null | undefined, loadingDraft: boolean) {
	const formRef = useRef<HTMLFormElement>(null);
	// While the draft loads the form holds the focus (it turns mail shortcuts off), so early keys never archive.
	useEffect(() => {
		if (draftIdToLoad && formRef.current && !formRef.current.contains(document.activeElement))
			formRef.current.focus({ preventScroll: true });
	}, [draftIdToLoad]);
	useEffect(() => {
		if (!draftIdToLoad || loadingDraft) return;
		formRef.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
	}, [draftIdToLoad, loadingDraft]);
	return formRef;
}
