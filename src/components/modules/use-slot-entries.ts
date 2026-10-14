"use client";

import { useEffect, useState } from "react";
import { slotsToLoad } from "@/lib/modules/composer-slot-utils";
import type { ModuleId } from "@/lib/modules/module-types";
import { loadModuleClient } from "./client-registry";
import type { ModuleClient } from "./client-registry-types";

/**
 * The client entries of the listed slots, by slot id. Each module's chunk is requested the first time
 * `opened` turns true, so a placement that is never opened loads nothing; a slot whose chunk has no
 * entry for its id stays absent. Pass a `pick` defined outside the component, or every render reloads.
 */
export function useSlotEntries<T>(
	slots: readonly { id: string; moduleId: ModuleId }[],
	opened: boolean,
	pick: (client: ModuleClient, slotId: string) => T | undefined,
): Record<string, T> {
	const [loaded, setLoaded] = useState<Record<string, T>>({});

	useEffect(() => {
		let cancelled = false;
		for (const slot of slotsToLoad(slots, opened)) {
			void loadModuleClient(slot.moduleId)
				?.then((client) => {
					const entry = pick(client, slot.id);
					if (entry && !cancelled) setLoaded((current) => ({ ...current, [slot.id]: entry }));
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [slots, opened, pick]);

	return loaded;
}
