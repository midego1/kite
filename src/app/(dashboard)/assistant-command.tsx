"use client";

import { useCommandHandler } from "@/components/shortcuts";

/**
 * Offers "Open Kite AI" to the palette and binds its key while mounted. The layout mounts it only while the
 * assistant is on, so the command and the key appear as soon as an admin enables it and go when it is off.
 */
export function AssistantCommand({ toggle }: { toggle: () => void }) {
	useCommandHandler("open-assistant", toggle);
	return null;
}
