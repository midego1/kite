"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useAuthMe } from "@/hooks/use-auth-me";
import { readInitialAssistantPanelState, saveAssistantPanelState } from "./dashboard-state-utils";

/** True from the first time `active` is true; lets a lazily loaded panel mount on first open and then stay mounted. */
export function useLatch(active: boolean) {
	const [latched, setLatched] = useState(active);
	if (active && !latched) setLatched(true);
	return latched || active;
}

export function useDashboardState() {
	const [assistantOpen, setAssistantOpen] = useState(false);
	const [assistantFullSize, setAssistantFullSize] = useState(false);
	const [panelRestored, setPanelRestored] = useState(false);
	const [storagePrefix, setStoragePrefix] = useState<string | null>(null);
	const userId = useAuthMe().data?.user?.id ?? null;

	useLayoutEffect(() => {
		const saved = readInitialAssistantPanelState();
		// Persisted preferences are only readable in the browser and must apply before paint.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setAssistantOpen(saved.open);
		setAssistantFullSize(saved.fullSize);
		setPanelRestored(true);
	}, []);

	useEffect(() => {
		if (!userId) return;
		const prefix = `kite-dashboard:${userId}`;
		try {
			const savedOpen = localStorage.getItem(`${prefix}:assistant-open`);
			const savedFullSize = localStorage.getItem(`${prefix}:assistant-full-size`);
			const initial = readInitialAssistantPanelState();
			// Must run after the layout effect above so per-account preferences override the device default.
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setAssistantOpen(savedOpen === null ? initial.open : savedOpen === "true");
			setAssistantFullSize(savedFullSize === null ? initial.fullSize : savedFullSize === "true");
		} catch {
			/* Storage is optional. */
		}
		setStoragePrefix(prefix);
	}, [userId]);

	useEffect(() => {
		if (!panelRestored) return;
		saveAssistantPanelState(assistantOpen, assistantFullSize, storagePrefix);
	}, [panelRestored, storagePrefix, assistantOpen, assistantFullSize]);

	return { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize };
}
