"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarSync, MoreVertical } from "lucide-react";
import { CalendarViewOptions } from "./view-selector";
import type { CalendarHeaderMenuProps } from "./header-menu-types";

const ITEM_CLASS =
	"cursor-pointer rounded-lg px-3 py-2 text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";
const ICON_BUTTON_CLASS =
	"flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 pointer-coarse:h-11 pointer-coarse:w-11";

/**
 * The calendar header's overflow menu (Today, the views and Subscribe) for a narrow header, and the Subscribe icon
 * button that takes its place once the header is wide enough for Today and the view switcher.
 */
export function CalendarHeaderMenu({ view, onView, onToday, onSubscribe }: CalendarHeaderMenuProps) {
	return (
		<>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button type="button" aria-label="Calendar options" className={`${ICON_BUTTON_CLASS} @3xl:hidden`}>
						<MoreVertical className="h-5 w-5" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="end"
						sideOffset={4}
						// Portalled to the body, so it cannot see the header's @container: the trigger above already
						// gates whether this can open at all, so this needs no width class of its own.
						className="z-[130] min-w-40 rounded-xl border border-neutral-200 bg-white p-1 text-sm shadow-xl"
					>
						<DropdownMenu.Item onSelect={onToday} className={ITEM_CLASS}>
							Today
						</DropdownMenu.Item>
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<CalendarViewOptions value={view} onChange={onView} />
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item onSelect={onSubscribe} className={ITEM_CLASS}>
							Subscribe…
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<button
				type="button"
				aria-label="Subscribe from another calendar app"
				title="Subscribe from another calendar app"
				onClick={onSubscribe}
				className={`${ICON_BUTTON_CLASS} @max-3xl:hidden`}
			>
				<CalendarSync className="h-4 w-4" />
			</button>
		</>
	);
}
