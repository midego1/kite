"use client";

import { useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";
import { SETTING_ROW_CLASS } from "@/components/ui/page-utils";
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
		<label className={SETTING_ROW_CLASS}>
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">Use the same layout on every device</span>
				<span className="mt-1 block text-sm text-neutral-500">
					The reading pane, density, conversation view, the size of the message list and the font follow your account.
					Turn this off to keep this browser&apos;s own layout.
				</span>
			</span>
			<Switch checked={enabled} onCheckedChange={setLayoutSyncEnabled} />
		</label>
	);
}
