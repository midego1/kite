"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, MoreHorizontal } from "lucide-react";
import { subscriptionPath, writeWithUndo } from "./subscription-writes";
import type { SubscriptionItem } from "./subscriptions-types";
import {
	cancelBeforeText,
	REMINDER_DAYS,
	reminderLabel,
	reminderToast,
	statusChoices,
	statusLabel,
} from "./subscriptions-utils";

const ITEM_CLASS =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 data-[state=open]:bg-neutral-100";
const CONTENT_CLASS = "z-[130] min-w-56 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg";

type MenuProps = {
	item: SubscriptionItem;
	onEdit: () => void;
	onCancelLink: () => void;
	onChanged: () => void;
};

function ReminderMenu({ item, onChanged }: Pick<MenuProps, "item" | "onChanged">) {
	const patch = (body: { reminderDays?: number; calendarReminder?: boolean }, message: string) =>
		void writeWithUndo({ path: subscriptionPath(item.id), method: "PATCH", body }, message, onChanged);
	return (
		<DropdownMenu.Sub>
			<DropdownMenu.SubTrigger className={`${ITEM_CLASS} justify-between`}>
				Reminder
				<ChevronRight aria-hidden className="h-4 w-4 text-neutral-400" />
			</DropdownMenu.SubTrigger>
			<DropdownMenu.Portal>
				<DropdownMenu.SubContent sideOffset={4} className={CONTENT_CLASS} data-finance-reminder-menu>
					{REMINDER_DAYS.map((days) => (
						<DropdownMenu.CheckboxItem
							key={days}
							checked={item.reminderDays === days}
							className={ITEM_CLASS}
							onSelect={() => {
								if (item.reminderDays !== days) patch({ reminderDays: days }, reminderToast(days));
							}}
						>
							<span className="w-4">
								<DropdownMenu.ItemIndicator>
									<Check aria-hidden className="h-4 w-4" />
								</DropdownMenu.ItemIndicator>
							</span>
							{reminderLabel(days)}
						</DropdownMenu.CheckboxItem>
					))}
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.CheckboxItem
						checked={item.calendarReminder}
						className={ITEM_CLASS}
						onSelect={() =>
							patch(
								{ calendarReminder: !item.calendarReminder },
								item.calendarReminder ? "Calendar reminder turned off" : "Calendar reminder turned on",
							)
						}
					>
						<span className="w-4">
							<DropdownMenu.ItemIndicator>
								<Check aria-hidden className="h-4 w-4" />
							</DropdownMenu.ItemIndicator>
						</span>
						Add to calendar
					</DropdownMenu.CheckboxItem>
				</DropdownMenu.SubContent>
			</DropdownMenu.Portal>
		</DropdownMenu.Sub>
	);
}

/** The row's "⋯" menu: Edit, Reminder, the status changes, Cancel before … and Remove. */
export function SubscriptionRowMenu({ item, onEdit, onCancelLink, onChanged }: MenuProps) {
	const setStatus = (status: SubscriptionItem["status"]) =>
		void writeWithUndo(
			{ path: subscriptionPath(item.id), method: "PATCH", body: { status } },
			`Marked as ${statusLabel(status).toLowerCase()}`,
			onChanged,
		);
	return (
		<DropdownMenu.Root modal={false}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label={`More actions for ${item.vendor}`}
					className="shrink-0 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<MoreHorizontal aria-hidden className="h-4 w-4" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={4} className={CONTENT_CLASS} data-finance-row-menu>
					<DropdownMenu.Item className={ITEM_CLASS} onSelect={onEdit}>
						Edit
					</DropdownMenu.Item>
					<ReminderMenu item={item} onChanged={onChanged} />
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					{statusChoices(item.status).map((choice) => (
						<DropdownMenu.Item key={choice.status} className={ITEM_CLASS} onSelect={() => setStatus(choice.status)}>
							{choice.label}
						</DropdownMenu.Item>
					))}
					{item.cancelUrl && (
						<DropdownMenu.Item className={ITEM_CLASS} onSelect={onCancelLink}>
							{cancelBeforeText(item)}
						</DropdownMenu.Item>
					)}
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Item
						className={`${ITEM_CLASS} text-red-600`}
						onSelect={() =>
							void writeWithUndo(
								{ path: subscriptionPath(item.id), method: "DELETE" },
								`Removed ${item.vendor}`,
								onChanged,
							)
						}
					>
						Remove
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
