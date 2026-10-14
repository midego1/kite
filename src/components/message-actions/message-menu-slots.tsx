"use client";

import { createElement, useMemo, useState, type ReactNode } from "react";
import { resolveNavIcon } from "@/components/modules/client-registry";
import type { MessageSlotContext, ModuleClient } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { useSlotEntries } from "@/components/modules/use-slot-entries";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { listMessageSlots } from "@/lib/modules/composer-slot-utils";

const pickMessageSlot = (client: ModuleClient, slotId: string) => client.messageSlots?.[slotId];

/**
 * The reader overflow menu entries of enabled modules. `opened` is whether the menu is open now; chunks
 * load the first time it is, and an entry appears once its chunk has loaded. `items` goes inside the menu, `overlays` beside it, since
 * the menu unmounts when it closes. Slot components receive only the message and mailbox ids.
 */
export function useMessageMenuSlots(
	context: MessageSlotContext,
	opened: boolean,
	closeMenu: () => void,
): { items: ReactNode; overlays: ReactNode } {
	const { modules } = useModules();
	const slots = useMemo(() => listMessageSlots(CLIENT_MODULES, modules, "message-menu"), [modules]);
	const [everOpened, setEverOpened] = useState(opened);
	if (opened && !everOpened) setEverOpened(true);
	const loaded = useSlotEntries(slots, everOpened, pickMessageSlot);
	const [openOverlay, setOpenOverlay] = useState<string | null>(null);
	const ready = slots.flatMap((slot) => (loaded[slot.id] ? [{ slot, entry: loaded[slot.id] }] : []));
	const { messageId, mailboxId } = context;

	return {
		items:
			ready.length > 0 ? (
				<>
					{ready.map(({ slot }) => (
						<button
							key={slot.id}
							type="button"
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
							onClick={() => {
								closeMenu();
								setOpenOverlay(slot.id);
							}}
						>
							{createElement(resolveNavIcon(slot.icon ?? ""), { className: "h-4 w-4 shrink-0" })}
							{slot.label}
						</button>
					))}
					<hr className="my-1 border-neutral-100" />
				</>
			) : null,
		overlays: ready.map(({ slot, entry }) => (
			<entry.Overlay
				key={slot.id}
				messageId={messageId}
				mailboxId={mailboxId}
				open={openOverlay === slot.id}
				onOpenChange={(open) => setOpenOverlay(open ? slot.id : null)}
			/>
		)),
	};
}
