import { Check, ChevronDown } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CalendarView } from "./types";

type Props = { value: CalendarView; onChange: (view: CalendarView) => void };
const views: CalendarView[] = ["month", "week", "day"];

export function CalendarViewOptions({ value, onChange }: Props) {
	return views.map((view) => (
		<DropdownMenu.Item
			key={view}
			onSelect={() => onChange(view)}
			className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 capitalize text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"
		>
			{view}
			{value === view && <Check className="h-4 w-4 text-blue-600" />}
		</DropdownMenu.Item>
	));
}

export function CalendarViewSelect({ value, onChange }: Props) {
	return (
		<div className="relative max-md:hidden">
			<select
				value={value}
				onChange={(event) => onChange(event.target.value as CalendarView)}
				aria-label="Calendar view"
				className="h-10 appearance-none rounded-full border-0 bg-white pl-4 pr-10 text-sm font-medium capitalize text-neutral-700 hover:bg-neutral-50"
			>
				{views.map((view) => (
					<option key={view} value={view} className="capitalize">
						{view}
					</option>
				))}
			</select>
			<ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-600" />
		</div>
	);
}
