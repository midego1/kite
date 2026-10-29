"use client";

import { createContext, useContext } from "react";

export const AssistantOpenContext = createContext(false);

export function useAssistantOpen() {
	return useContext(AssistantOpenContext);
}

// True while the assistant chat window sits in the bottom-right corner, where the floating composer also docks.
export const AssistantDockedContext = createContext(false);

export function useAssistantDocked() {
	return useContext(AssistantDockedContext);
}

/** What the Kite AI button in the reader toolbar needs; null outside the dashboard. */
export type AssistantToggleState = {
	/** False while the assistant is off for this install, which hides every entry point. */
	available: boolean;
	open: boolean;
	toggle: () => void;
};

export const AssistantToggleContext = createContext<AssistantToggleState | null>(null);

export function useAssistantToggle() {
	return useContext(AssistantToggleContext);
}
