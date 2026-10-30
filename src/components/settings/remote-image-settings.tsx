"use client";

import { useLoadRemoteImages } from "@/components/messages/use-load-remote-images";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/ui/page";

export function RemoteImageSettings() {
	const [enabled, setEnabled] = useLoadRemoteImages();

	return (
		<SettingRow
			label="Always show remote images"
			description="Images hosted elsewhere can tell the sender when and where you opened a message. When off, each message asks before loading them. This applies to this browser."
			control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Always show remote images" />}
		/>
	);
}
