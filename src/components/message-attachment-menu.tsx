"use client";

import { createElement, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { MoreVertical } from "lucide-react";
import { resolveNavIcon } from "@/components/modules/client-registry";
import type { AttachmentSlotContext, ModuleClient } from "@/components/modules/client-registry-types";
import { useModules } from "@/components/modules/modules-context";
import { useSlotEntries } from "@/components/modules/use-slot-entries";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { listAttachmentSlots } from "@/lib/modules/composer-slot-utils";

const pickAttachmentSlot = (client: ModuleClient, slotId: string) => client.attachmentSlots?.[slotId];

/** Whether any enabled module adds an entry to the attachment menu, so the card can leave room for its trigger. */
export function useHasAttachmentSlots(): boolean {
	const { modules } = useModules();
	return useMemo(() => listAttachmentSlots(CLIENT_MODULES, modules, "attachment-menu").length > 0, [modules]);
}

/**
 * The menu of one reader attachment, filled only by enabled modules; nothing is drawn when none declares an
 * entry. Chunks load the first time the menu opens, and slot components receive only the message, mailbox and
 * attachment ids.
 */
export function MessageAttachmentMenu({
	messageId,
	mailboxId,
	attachmentId,
	filename,
}: AttachmentSlotContext & { filename: string }) {
	const { modules } = useModules();
	const slots = useMemo(() => listAttachmentSlots(CLIENT_MODULES, modules, "attachment-menu"), [modules]);
	const [open, setOpen] = useState(false);
	const [everOpened, setEverOpened] = useState(false);
	if (open && !everOpened) setEverOpened(true);
	const loaded = useSlotEntries(slots, everOpened, pickAttachmentSlot);
	const [openOverlay, setOpenOverlay] = useState<string | null>(null);
	if (slots.length === 0) return null;
	const ready = slots.flatMap((slot) => (loaded[slot.id] ? [{ slot, entry: loaded[slot.id] }] : []));

	return (
		<>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label={`More actions for ${filename}`}
						className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<MoreVertical className="h-4 w-4" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={4}
						collisionPadding={8}
						aria-label={`Actions for ${filename}`}
						className="z-50 w-54 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
					>
						{ready.length === 0 && <p className="px-3 py-2 text-sm text-neutral-500">Loading…</p>}
						{ready.map(({ slot }) => (
							<button
								key={slot.id}
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => {
									setOpen(false);
									setOpenOverlay(slot.id);
								}}
							>
								{createElement(resolveNavIcon(slot.icon ?? ""), { className: "h-4 w-4 shrink-0" })}
								{slot.label}
							</button>
						))}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{ready.map(({ slot, entry }) => (
				<entry.Overlay
					key={slot.id}
					messageId={messageId}
					mailboxId={mailboxId}
					attachmentId={attachmentId}
					open={openOverlay === slot.id}
					onOpenChange={(next) => setOpenOverlay(next ? slot.id : null)}
				/>
			))}
		</>
	);
}
