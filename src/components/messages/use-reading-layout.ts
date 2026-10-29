import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import type { LayoutPreferences } from "@/lib/preferences/layout-types";
import type { MessageListDensity, ReadingPaneMode } from "./reading-layout-types";
import {
	DEFAULT_MESSAGE_DENSITY,
	DEFAULT_READING_PANE_MODE,
	LEGACY_TWO_COLUMN_STORAGE_KEY,
	MESSAGE_DENSITY_STORAGE_KEY,
	READING_LAYOUT_CHANGE_EVENT as CHANGE_EVENT,
	READING_PANE_STORAGE_KEY,
	WIDE_READING_QUERY,
	parseMessageListDensity,
	parseReadingPaneMode,
} from "./reading-layout-utils";

function readItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeItem(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Blocked storage: the choice still applies to the open pages until they close.
	}
}

export function readReadingPaneMode(): ReadingPaneMode {
	return parseReadingPaneMode(readItem(READING_PANE_STORAGE_KEY), readItem(LEGACY_TWO_COLUMN_STORAGE_KEY));
}

export function readMessageListDensity(): MessageListDensity {
	return parseMessageListDensity(readItem(MESSAGE_DENSITY_STORAGE_KEY));
}

function useStoredPreference<T extends string>(
	fallback: T,
	read: () => T,
	key: string,
	toLayout: (value: T) => LayoutPreferences,
): [T, (next: T) => void] {
	const [value, setValue] = useState<T>(fallback);

	useLayoutEffect(() => {
		// The stored choice is only readable in the browser and must apply before paint.
		const sync = () => setValue(read());
		sync();
		window.addEventListener(CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, [read]);

	const update = useCallback(
		(next: T) => {
			writeItem(key, next);
			setValue(next);
			window.dispatchEvent(new Event(CHANGE_EVENT));
			queueLayoutSave(toLayout(next));
		},
		[key, toLayout],
	);

	return [value, update];
}

const readingPaneLayout = (readingPane: ReadingPaneMode): LayoutPreferences => ({ readingPane });
const densityLayout = (density: MessageListDensity): LayoutPreferences => ({ density });

/**
 * Where open emails appear, remembered in the browser and saved to the account; every open list follows a
 * change immediately.
 */
export function useReadingPaneMode(): [ReadingPaneMode, (next: ReadingPaneMode) => void] {
	return useStoredPreference(
		DEFAULT_READING_PANE_MODE,
		readReadingPaneMode,
		READING_PANE_STORAGE_KEY,
		readingPaneLayout,
	);
}

export function useMessageListDensity(): [MessageListDensity, (next: MessageListDensity) => void] {
	return useStoredPreference(
		DEFAULT_MESSAGE_DENSITY,
		readMessageListDensity,
		MESSAGE_DENSITY_STORAGE_KEY,
		densityLayout,
	);
}

export function useWideReadingViewport(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const media = window.matchMedia(WIDE_READING_QUERY);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		() => window.matchMedia(WIDE_READING_QUERY).matches,
		() => true,
	);
}
