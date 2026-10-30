"use client";

import { useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/ui/page";
import { isLayoutSyncEnabled, setLayoutSyncEnabled } from "@/components/layout-preferences-client";
import { LAYOUT_SYNC_CHANGE_EVENT } from "@/components/layout-preferences-utils";

function subscribe(onChange: () => void) {
	window.addEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
}

/** The per-browser switch between the account's layout and this browser's own. */
export function LayoutSyncSetting() {
	const enabled = useSyncExternalStore(subscribe, isLayoutSyncEnabled, () => true);

	return (
		<SettingRow
			label="Use the same layout on every device"
			description="The reading pane, density, conversation view and the size of the message list follow your account. Turn this off to keep this browser's own layout."
			control={<Switch checked={enabled} onCheckedChange={setLayoutSyncEnabled} />}
		/>
	);
}
