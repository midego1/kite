"use client";

import { useCallback, useEffect, useState } from "react";
import type { SendingSettings } from "./use-sending-settings-types";
import { loadSendingSettings, updateSendingSettings } from "./use-sending-settings-utils";

const DEFAULT_SETTINGS: SendingSettings = { previewEnabled: false, undoSeconds: 0 };

/** The signed-in user's send preview and undo window. Both default to off. */
export function useSendingSettings() {
	const [settings, setSettingsState] = useState<SendingSettings>(DEFAULT_SETTINGS);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		loadSendingSettings()
			.then((stored) => {
				if (!cancelled) setSettingsState(stored);
			})
			.catch((loadError) => {
				if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load sending settings");
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const update = useCallback(
		async (patch: Partial<SendingSettings>) => {
			const previous = settings;
			setSettingsState({ ...settings, ...patch });
			setError(null);
			try {
				setSettingsState(await updateSendingSettings(patch));
			} catch (updateError) {
				setSettingsState(previous);
				const message = updateError instanceof Error ? updateError.message : "Failed to update sending settings";
				setError(message);
				throw new Error(message);
			}
		},
		[settings],
	);

	return { settings, error, isLoading, update };
}
