"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const STORED_STATE_CHANGED_EVENT = "kite:stored-state-changed";
// Keeps values for the session when localStorage is unavailable (private windows).
const memoryFallback = new Map<string, string>();

function subscribe(onChange: () => void) {
	window.addEventListener("storage", onChange);
	window.addEventListener(STORED_STATE_CHANGED_EVENT, onChange);
	return () => {
		window.removeEventListener("storage", onChange);
		window.removeEventListener(STORED_STATE_CHANGED_EVENT, onChange);
	};
}

function readRaw(key: string): string | null {
	try {
		return localStorage.getItem(key) ?? memoryFallback.get(key) ?? null;
	} catch {
		return memoryFallback.get(key) ?? null;
	}
}

function writeRaw(key: string, raw: string) {
	memoryFallback.set(key, raw);
	try {
		localStorage.setItem(key, raw);
	} catch {
		// The in-memory copy still applies for this session.
	}
	window.dispatchEvent(new Event(STORED_STATE_CHANGED_EVENT));
}

/**
 * JSON state persisted in localStorage. Server rendering and hydration see
 * `fallback`; the stored value applies right after hydration.
 */
export function useStoredState<T>(key: string, fallback: T): [T, (value: T) => void] {
	const raw = useSyncExternalStore(
		subscribe,
		() => readRaw(key),
		() => null,
	);
	const value = useMemo(() => {
		if (raw === null) return fallback;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return fallback;
		}
	}, [raw, fallback]);
	const setValue = useCallback((next: T) => writeRaw(key, JSON.stringify(next)), [key]);
	return [value, setValue];
}
