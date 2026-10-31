"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CommandCenterCard } from "@/components/command-center/command-center-card";
import { useCommandCenterCardQuery } from "@/components/command-center/use-card-query";
import type { ReadingPaneSlotContext } from "@/components/modules/client-registry-types";
import type { CalendarEvent } from "@/app/(calendar)/calendar/types";
import { addDays, expandCalendarEvents, startOfDay } from "@/app/(calendar)/calendar/utils";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import { todayLines } from "./today-card-utils";

/**
 * The command center's Today card: what is left of today's calendar, with a link to the Calendar. It draws
 * nothing until the events are in, and nothing at all when they cannot be read (Calendar off, an error). The
 * day's events are reused for a minute when the pane comes back after a message was closed.
 */
export function TodayCard(_context: ReadingPaneSlotContext) {
	// Read once per mount, like the pane's greeting: the pane is remounted whenever a message is closed.
	const day = useMemo(() => {
		const now = new Date();
		const start = startOfDay(now);
		return { now, start, end: addDays(start, 1), timeZone: getUserTimeZone() };
	}, []);
	const events = useCommandCenterCardQuery(["calendar.today", day.start.toISOString()], async () => {
		const response = await authFetch(
			`/api/calendar/events?start=${day.start.toISOString()}&end=${day.end.toISOString()}`,
		);
		if (!response.ok) throw new Error(`Calendar events request failed (${response.status})`);
		const data = (await response.json()) as { events?: CalendarEvent[] };
		return expandCalendarEvents(data.events ?? [], day.start, day.end);
	});

	if (!events) return null;
	const { lines, more, empty } = todayLines(events, { now: day.now, dayStart: day.start, timeZone: day.timeZone });
	return (
		<CommandCenterCard title="Today" action={{ label: "Calendar", href: "/calendar" }} testId="command-center-today">
			{lines.length === 0 ? (
				<p className="py-1.5 text-sm text-neutral-700">{empty}</p>
			) : (
				<ul className="divide-y divide-cc-border">
					{lines.map((line) => (
						<li key={line.id}>
							<Link
								href={line.href}
								className="flex items-center gap-3 py-2 text-sm text-neutral-900 hover:text-cc-accent"
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
				<Link href="/calendar" className="mt-1 block text-xs font-medium text-cc-accent hover:underline">
					{more} more today
				</Link>
			)}
		</CommandCenterCard>
	);
}
