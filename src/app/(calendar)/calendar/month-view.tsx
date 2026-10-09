import { Plus } from "lucide-react";
import { formatUserDate } from "@/lib/time/utils";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import { addDays, dateKey, EVENT_COLOR_CLASSES, monthGridDates } from "./utils";
import type { MonthViewProps } from "./month-view-types";

export function MonthView({ date, today, events, onEdit, onAdd, onShowDay }: MonthViewProps) {
	const days = monthGridDates(date);
	const month = dateKey(date).slice(0, 7);
	return (
		<div aria-label="Monthly calendar" className="flex min-h-full min-w-140 flex-col">
			<div className="sticky top-0 z-10 grid grid-cols-7 border-b border-neutral-200 bg-white">
				{days.slice(0, 7).map((day) => (
					<div key={dateKey(day)} className="px-3 py-2 text-center text-xs font-medium text-neutral-500">
						{formatUserDate(day, { weekday: "short" })}
					</div>
				))}
			</div>
			<div className="grid flex-1 grid-cols-7 grid-rows-6">
				{days.map((day) => {
					const key = dateKey(day);
					const end = addDays(day, 1);
					const daily = events
						.filter((event) => new Date(event.startsAt) < end && new Date(event.endsAt) > day)
						.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
					const isToday = key === dateKey(today);
					return (
						<section
							key={key}
							aria-label={formatUserDate(day, { dateStyle: "full" })}
							className={`min-h-28 min-w-0 border-b border-r border-neutral-100 p-1.5 ${key.slice(0, 7) === month ? "bg-white" : "bg-neutral-50 text-neutral-400"}`}
						>
							<div className="mb-1 flex items-center justify-between">
								<button
									type="button"
									onClick={() => onShowDay(day)}
									aria-label={`Show day ${key}`}
									aria-current={isToday ? "date" : undefined}
									className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${isToday ? "bg-blue-600 text-white" : "hover:bg-blue-100"}`}
								>
									{formatUserDate(day, { day: "numeric" })}
								</button>
								<button
									type="button"
									onClick={() => onAdd(day)}
									aria-label={`Add event on ${key}`}
									className="rounded p-1 text-neutral-400 hover:bg-blue-50 hover:text-blue-700"
								>
									<Plus size={12} aria-hidden="true" />
								</button>
							</div>
							<div className="space-y-1">
								{daily.slice(0, 3).map((event) => (
									<button
										key={`${event.id}:${event.startsAt}`}
										type="button"
										onClick={() => onEdit(event)}
										title={event.title}
										className={`block w-full truncate rounded px-1.5 py-1 text-left text-xs ${EVENT_COLOR_CLASSES[normalizeCalendarColor(event.color)]}`}
									>
										<span className="mr-1 opacity-75">
											{formatUserDate(new Date(event.startsAt), { hour: "numeric", minute: "2-digit" })}
										</span>
										{event.title}
									</button>
								))}
								{daily.length > 3 && (
									<button
										type="button"
										onClick={() => onShowDay(day)}
										className="rounded px-1.5 py-1 text-xs text-blue-700 hover:bg-blue-50"
									>
										+{daily.length - 3} more
									</button>
								)}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}
