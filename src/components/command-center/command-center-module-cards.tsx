"use client";

import { Component, useMemo, type ReactNode } from "react";
import { loadModulePaneClient } from "@/components/modules/client-registry";
import type { ModulePaneClient } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { useSlotEntries } from "@/components/modules/use-slot-entries";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { listReadingPaneSlots } from "@/lib/modules/composer-slot-utils";
import { useCommandCenterCardEvents } from "./use-card-query";

const pickReadingPaneSlot = (client: ModulePaneClient, slotId: string) => client.readingPaneSlots?.[slotId];

/** A card that throws while rendering is left out; the rest of the pane stays. */
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/**
 * The cards modules add to the command center (`reading-pane` slots), for the modules on for the user, in
 * declared order. Each module's pane chunk is requested once the pane has rendered, and each card fetches
 * its own data and draws nothing until it has some, so a module that is off, failing or not migrated yet
 * leaves no trace. Their data is kept for a minute (`useCommandCenterCardQuery`) and refreshed on a module notice
 * or a suggestion change. Core names no module here.
 */
export function CommandCenterModuleCards({ mailboxId }: { mailboxId: string | null }) {
	const { modules } = useModules();
	const slots = useMemo(() => listReadingPaneSlots(CLIENT_MODULES, modules, "reading-pane"), [modules]);
	const loaded = useSlotEntries(slots, true, pickReadingPaneSlot, loadModulePaneClient);
	useCommandCenterCardEvents();
	return slots.map((slot) => {
		const entry = loaded[slot.id];
		if (!entry) return null;
		return (
			<CardBoundary key={slot.id}>
				<entry.Card mailboxId={mailboxId} />
			</CardBoundary>
		);
	});
}
