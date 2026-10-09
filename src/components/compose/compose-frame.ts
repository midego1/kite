"use client";

import { useAssistantDocked } from "@/components/agent/assistant-open-state";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { cn } from "@/lib/utils";

type ComposeFrameState = {
	mode: "page" | "popup";
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
	if (mode !== "popup")
		return "relative flex h-full min-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm";
	if (minimized)
		return "fixed bottom-0 right-8 z-40 flex h-9 w-[min(260px,calc(100vw-32px))] flex-col overflow-hidden rounded-t-lg border border-neutral-200 bg-white shadow-2xl";
	if (modalMode)
		return "fixed left-1/2 top-1/2 z-50 flex h-[86vh] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-white shadow-2xl";
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
