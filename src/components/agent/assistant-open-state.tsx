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
