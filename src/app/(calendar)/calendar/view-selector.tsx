import { Check } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Select } from "@/components/ui/select";
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
		<Select
			value={value}
			onChange={(event) => onChange(event.target.value as CalendarView)}
			aria-label="Calendar view"
			containerClassName="h-8 bg-white max-md:hidden"
			className="text-sm font-medium text-neutral-700"
		>
			{views.map((view) => (
				<option key={view} value={view}>
					{view.charAt(0).toUpperCase() + view.slice(1)}
				</option>
			))}
		</Select>
	);
}
