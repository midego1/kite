"use client";

import { useState } from "react";
import { useShortcuts } from "@/components/shortcuts";
import { Switch } from "@/components/ui/switch";
import { FormError, SettingRow } from "@/components/ui/page";

export function InboxShortcutsSettings() {
	const { shortcutsEnabled, shortcutsPreferenceLoading, shortcutsPreferenceError, setShortcutsEnabled } =
		useShortcuts();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	return (
		<SettingRow
			label="Keyboard shortcuts"
			description="Use quick keys to navigate, compose, and manage messages on this account."
			control={
				<Switch
					checked={shortcutsEnabled}
					disabled={shortcutsPreferenceLoading || saving}
					onCheckedChange={(enabled) => {
						setSaving(true);
						setSaveError(null);
						void setShortcutsEnabled(enabled)
							.catch((error) =>
								setSaveError(error instanceof Error ? error.message : "Failed to update shortcut settings"),
							)
							.finally(() => setSaving(false));
					}}
					aria-label="Enable keyboard shortcuts"
				/>
			}
		>
			{(saveError || shortcutsPreferenceError) && (
				<FormError className="mt-2 px-4">{saveError || shortcutsPreferenceError}</FormError>
			)}
		</SettingRow>
	);
}
