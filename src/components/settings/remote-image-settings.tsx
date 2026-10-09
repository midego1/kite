"use client";

import { useLoadRemoteImages } from "@/components/messages/use-load-remote-images";
import { Switch } from "@/components/ui/switch";

export function RemoteImageSettings() {
	const [enabled, setEnabled] = useLoadRemoteImages();

	return (
		<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">Always show remote images</span>
				<span className="mt-1 block text-sm text-neutral-500">
					Images hosted elsewhere can tell the sender when and where you opened a message. When off, each message asks
					before loading them. This applies to this browser.
				</span>
			</span>
			<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Always show remote images" />
		</label>
	);
}
