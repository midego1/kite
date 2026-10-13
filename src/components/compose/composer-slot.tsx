"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadModuleClient } from "@/components/modules/client-registry";
import type { ComposerSlotContext, ModuleComposerSlot } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { listComposerSlots, slotsToLoad } from "@/lib/modules/composer-slot-utils";
import type { ComposerSlotDeclaration } from "@/lib/modules/module-types";

/**
 * What the enabled modules add to one composer placement. Their client chunks load the first time
 * `opened` turns true and only for modules that are on, so mounting the composer or having none on
 * makes no request and draws no separator.
 * `menu` goes inside the placement's menu; `overlays` goes beside it, outside the menu that unmounts on close.
 */
export function useComposerSlots(
	placement: ComposerSlotDeclaration["slot"],
	context: ComposerSlotContext,
	opened: boolean,
): { menu: ReactNode; overlays: ReactNode } {
	const { modules } = useModules();
	const slots = useMemo(() => listComposerSlots(CLIENT_MODULES, modules, placement), [modules, placement]);
	const [loaded, setLoaded] = useState<Record<string, ModuleComposerSlot>>({});
	const [openOverlay, setOpenOverlay] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		for (const slot of slotsToLoad(slots, opened)) {
			void loadModuleClient(slot.moduleId)
				?.then((client) => {
					const entry = client.composerSlots?.[slot.id];
					if (entry && !cancelled) setLoaded((current) => ({ ...current, [slot.id]: entry }));
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [slots, opened]);

	const ready = slots.flatMap((slot) => (loaded[slot.id] ? [{ slot, entry: loaded[slot.id] }] : []));
	return {
		menu:
			ready.length > 0 ? (
				<>
					{ready.map(({ slot, entry }) => (
						<entry.MenuItem key={slot.id} {...context} openOverlay={() => setOpenOverlay(slot.id)} />
					))}
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
				</>
			) : null,
		overlays: ready.map(({ slot, entry }) =>
			entry.Overlay ? (
				<entry.Overlay
					key={slot.id}
					{...context}
					open={openOverlay === slot.id}
					onOpenChange={(open) => setOpenOverlay(open ? slot.id : null)}
				/>
			) : null,
		),
	};
}
