"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local state seeded from a value that the user can change optimistically,
 * reset whenever the source value changes. The reset happens during render,
 * so the stale local value is never painted.
 */
export function useSyncedState<T>(source: T): [T, Dispatch<SetStateAction<T>>] {
	const [state, setState] = useState(source);
	const [previousSource, setPreviousSource] = useState(source);
	if (!Object.is(previousSource, source)) {
		setPreviousSource(source);
		setState(source);
	}
	return [state, setState];
}

/**
 * Returns true on the render in which `key` differs from the previous render's
 * key, so callers can reset related state during render instead of in an
 * effect. Callers must only set state when it returns true.
 */
export function useKeyChanged(key: unknown): boolean {
	const [previousKey, setPreviousKey] = useState(key);
	if (Object.is(previousKey, key)) return false;
	setPreviousKey(key);
	return true;
}
