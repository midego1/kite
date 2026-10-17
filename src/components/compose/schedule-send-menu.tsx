"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useComposerSlots } from "./composer-slot";
import {
	formatDateTimeLocal,
	formatScheduledSend,
	getScheduleSendOptions,
	parseDateTimeLocal,
} from "./schedule-send-utils";
import type { ScheduleSendMenuProps } from "./schedule-send-types";
import { getUserTimeZone } from "@/lib/time/utils";
import { PAST_SCHEDULE_MESSAGE, isPastScheduledSend } from "@/lib/email/undo-send-utils";

export function ScheduleSendMenu({ disabled, value, onChange, mailboxId, from, applyContent }: ScheduleSendMenuProps) {
	const [menuOpened, setMenuOpened] = useState(false);
	const slots = useComposerSlots("send-menu", { mailboxId, from, applyContent }, menuOpened);
	// Suggestions are computed from the moment the menu opens.
	const [openedAt, setOpenedAt] = useState(() => Date.now());
	// What was typed into the date field, kept so a past time can stay visible with its error.
	const [pickedText, setPickedText] = useState<string | null>(null);
	const options = getScheduleSendOptions(new Date(openedAt));
	const picked = pickedText === null ? null : parseDateTimeLocal(pickedText);
	const pastPicked = picked !== null && isPastScheduledSend(picked);

	function pick(text: string) {
		setPickedText(text);
		const parsed = parseDateTimeLocal(text);
		if (!parsed) onChange(null);
		else if (!isPastScheduledSend(parsed)) onChange(parsed);
	}

	return (
		<>
			<DropdownMenu.Root
				onOpenChange={(open) => {
					if (!open) return;
					setOpenedAt(Date.now());
					setPickedText(null);
					setMenuOpened(true);
				}}
			>
				<DropdownMenu.Trigger
					type="button"
					disabled={disabled}
					aria-label="Schedule send options"
					className="inline-flex h-8 items-center justify-center rounded-r-lg border-l border-blue-500 bg-blue-600 px-2 text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
				>
					<ChevronDown className="h-4 w-4" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="start"
						sideOffset={6}
						className="z-50 min-w-56 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg"
					>
						{slots.menu}
						<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">
							Schedule
						</DropdownMenu.Label>
						{value && (
							<>
								<DropdownMenu.Item
									onSelect={() => onChange(null)}
									className="flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
								>
									<X className="mr-2 h-4 w-4" />
									Clear schedule
								</DropdownMenu.Item>
								<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
							</>
						)}
						{options.map((option) => (
							<DropdownMenu.Item
								key={option.label}
								onSelect={() => onChange(option.value)}
								className="cursor-pointer rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
							>
								{option.label}
								<span className="ml-2 text-xs text-neutral-400">
									{option.value && formatScheduledSend(option.value)}
								</span>
							</DropdownMenu.Item>
						))}
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">
							Pick date &amp; time ({getUserTimeZone()})
						</DropdownMenu.Label>
						<input
							type="datetime-local"
							min={formatDateTimeLocal(new Date(openedAt))}
							value={pickedText ?? (value ? formatDateTimeLocal(value) : "")}
							onChange={(event) => pick(event.target.value)}
							onKeyDown={(event) => event.stopPropagation()}
							aria-label="Send date and time"
							aria-invalid={pastPicked || undefined}
							aria-describedby={pastPicked ? "schedule-send-past-time" : undefined}
							className="mx-2 mb-2 h-9 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400 aria-[invalid=true]:border-red-400"
						/>
						{pastPicked && (
							<p
								id="schedule-send-past-time"
								role="alert"
								className="mx-2 mb-2 max-w-56 text-xs text-red-600 dark:text-red-400"
							>
								{PAST_SCHEDULE_MESSAGE}
							</p>
						)}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			{slots.overlays}
		</>
	);
}
