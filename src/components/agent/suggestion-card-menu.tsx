"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { CardSuggestion } from "./suggestion-card-types";
import { runCardAction, type CardAction } from "./suggestion-card-actions";

const ITEM_CLASS =
	"flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";

const ITEMS: { action: CardAction; label: string }[] = [
	{ action: "dismiss", label: "Dismiss" },
	{ action: "mute", label: "Don't suggest this for this sender" },
	{ action: "pause", label: "Pause Kite for this mailbox" },
];

/** The "⋯" menu of one suggestion block. */
export function SuggestionCardMenu({ suggestion, onChanged }: { suggestion: CardSuggestion; onChanged: () => void }) {
	async function choose(action: CardAction) {
		if (await runCardAction(suggestion, action)) onChanged();
	}
	return (
		<DropdownMenu.Root modal={false}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label="More Kite actions"
					className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<MoreHorizontal aria-hidden className="h-4 w-4" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={4}
					className="z-[130] min-w-56 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					{ITEMS.map(({ action, label }) => (
						<DropdownMenu.Item key={action} className={ITEM_CLASS} onSelect={() => void choose(action)}>
							{label}
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
