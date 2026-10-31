"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CommandCenterCard } from "@/components/command-center/command-center-card";
import type { ReadingPaneSlotContext } from "@/components/modules/client-registry-types";
import type { CalendarEvent } from "@/app/(calendar)/calendar/types";
import { addDays, expandCalendarEvents, startOfDay } from "@/app/(calendar)/calendar/utils";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import { todayLines } from "./today-card-utils";

/**
 * The command center's Today card: what is left of today's calendar, with a link to the Calendar. It draws
 * nothing until the events are in, and nothing at all when they cannot be read (Calendar off, an error).
 */
export function TodayCard(_context: ReadingPaneSlotContext) {
	// Read once per mount, like the pane's greeting: the pane is remounted whenever a message is closed.
	const day = useMemo(() => {
		const now = new Date();
		const start = startOfDay(now);
		return { now, start, end: addDays(start, 1), timeZone: getUserTimeZone() };
	}, []);
	const [events, setEvents] = useState<CalendarEvent[] | null>(null);

	useEffect(() => {
		let live = true;
		void authFetch(`/api/calendar/events?start=${day.start.toISOString()}&end=${day.end.toISOString()}`)
			.then(async (response) => {
				if (!response.ok) throw new Error();
				return (await response.json()) as { events?: CalendarEvent[] };
			})
			.then((data) => {
				if (live) setEvents(expandCalendarEvents(data.events ?? [], day.start, day.end));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [day]);

	if (!events) return null;
	const { lines, more, empty } = todayLines(events, { now: day.now, dayEnd: day.end, timeZone: day.timeZone });
	return (
		<CommandCenterCard title="Today" action={{ label: "Calendar", href: "/calendar" }} testId="command-center-today">
			{lines.length === 0 ? (
				<p className="py-1.5 text-sm text-neutral-700">{empty}</p>
			) : (
				<ul className="divide-y divide-neutral-200/70">
					{lines.map((line) => (
						<li key={line.id}>
							<Link
								href={line.href}
								className="flex items-center gap-3 py-2 text-sm text-neutral-900 hover:text-blue-700"
								data-today-event
							>
								<span className="w-16 shrink-0 whitespace-nowrap tabular-nums text-neutral-500">{line.when}</span>
								<span className="min-w-0 flex-1 truncate">{line.what}</span>
								<span className="max-w-[40%] shrink-0 truncate text-xs text-neutral-500">{line.meta}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			{more > 0 && (
				<Link href="/calendar" className="mt-1 block text-xs font-medium text-blue-700 hover:underline">
					{more} more today
				</Link>
			)}
		</CommandCenterCard>
	);
}
