"use client";

import { Fragment, memo, useMemo } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { normalizeCalendarColor } from "@/lib/calendar/colors";
import {
	addDays,
	dateKey,
	EVENT_COLOR_CLASSES,
	eventPosition,
	formatEventRange,
	formatEventTime,
	PAST_EVENT_COLOR_CLASSES,
} from "./utils";
import type { CalendarEvent, EventResizeEdge } from "./types";
import type { DayEventsProps } from "./day-events-types";
import {
	eventBlockLayout,
	EVENT_BLOCK_FOCUS_CLASSES,
	inlineEventText,
	TENTATIVE_BLOCK_CLASSES,
} from "./event-block-utils";

// Memoized so pointer-move / drag-over preview updates in the page do not
// recompute positions (timezone math) and re-render every event block.
function DayEventsImpl({
	day,
	events,
	currentTime,
	busy,
	activeEventId,
	onEdit,
	onDragStart,
	onDragEnd,
	onResizeStart,
	onResizeMove,
	onResizeEnd,
	onResizeCancel,
}: DayEventsProps) {
	const nextDay = useMemo(() => addDays(day, 1), [day]);
	const items = useMemo(
		() =>
			events.flatMap((event) => {
				if (!(new Date(event.startsAt) < nextDay && new Date(event.endsAt) > day)) return [];
				const position = eventPosition(event, day);
				if (!position) return [];
				return [
					{
						event,
						position,
						color: normalizeCalendarColor(event.color),
						range: formatEventRange(event),
						startLabel: formatEventTime(new Date(event.startsAt)),
						endLabel: formatEventTime(new Date(event.endsAt)),
						canResizeStart: dateKey(new Date(event.startsAt)) === dateKey(day),
						canResizeEnd: new Date(event.endsAt).getTime() <= nextDay.getTime(),
					},
				];
			}),
		[events, day, nextDay],
	);

	return (
		<>
			{items.map(({ event, position, color, range, startLabel, endLabel, canResizeStart, canResizeEnd }) => {
				const isPastEvent = new Date(event.endsAt).getTime() <= currentTime;
				const edges = (["start", "end"] as const).filter((edge) => (edge === "start" ? canResizeStart : canResizeEnd));
				// Keep the grab zone inside the event so it never steals clicks from neighbours.
				const layout = eventBlockLayout(position.height);
				const handleHeight = Math.max(4, Math.min(10, position.height / 3));
				return (
					<Fragment key={event.id}>
						<button
							type="button"
							draggable={!busy}
							onClick={() => onEdit(event)}
							onDragStart={(dragEvent: DragEvent<HTMLButtonElement>) => onDragStart(dragEvent, event)}
							onDragEnd={onDragEnd}
							title={`${event.title} · ${range}${event.status === "tentative" ? " (Tentative)" : ""}`}
							data-status={event.status === "tentative" ? "tentative" : undefined}
							className={`absolute left-1 right-1 z-10 flex cursor-move flex-col items-start justify-start overflow-hidden rounded-lg pr-2 pl-4 text-left hover:brightness-95 ${EVENT_BLOCK_FOCUS_CLASSES} ${isPastEvent ? PAST_EVENT_COLOR_CLASSES[color] : EVENT_COLOR_CLASSES[color]} ${layout.paddingClass} ${activeEventId === event.id ? "opacity-40" : ""} ${event.status === "tentative" ? TENTATIVE_BLOCK_CLASSES : ""}`}
							style={{ top: position.top, height: position.height }}
						>
							<span className="absolute top-1 left-1 block h-[calc(100%-8px)] w-1 rounded-xl bg-current" />
							{layout.mode === "stacked" && (
								<>
									<span className="block w-full truncate text-[12px] font-semibold leading-4">
										{event.title}
										{event.status === "tentative" && (
											<span className="ml-1 text-[10px] font-normal italic leading-none">Tentative</span>
										)}
									</span>
									<span className="block w-full truncate text-[11px] leading-4 opacity-70">{range}</span>
								</>
							)}
							{layout.mode === "inline" && (
								<span
									className={clsx(
										"block w-full truncate text-[12px] font-semibold leading-4",
										event.status === "tentative" && "italic",
									)}
								>
									{inlineEventText({ title: event.title, startLabel, endLabel, startsOnDay: canResizeStart })}
									{event.status === "tentative" && <span className="sr-only"> (Tentative)</span>}
								</span>
							)}
						</button>
						{edges.map((edge: EventResizeEdge) => (
							<button
								key={edge}
								type="button"
								draggable={false}
								aria-label={`Resize ${edge} of ${event.title}`}
								onPointerDown={(pointerEvent: ReactPointerEvent<HTMLButtonElement>) =>
									onResizeStart(pointerEvent, event, day, edge)
								}
								onPointerMove={onResizeMove}
								onPointerUp={onResizeEnd}
								onPointerCancel={onResizeCancel}
								onClick={(clickEvent) => clickEvent.stopPropagation()}
								className={clsx(
									"absolute left-1 right-1 z-20 cursor-ns-resize touch-none bg-transparent focus-visible:outline-2 focus-visible:outline-blue-500",
								)}
								style={{
									height: handleHeight,
									top: edge === "start" ? position.top : position.top + position.height - handleHeight,
								}}
							/>
						))}
					</Fragment>
				);
			})}
		</>
	);
}

export const DayEvents = memo(DayEventsImpl);
export type { CalendarEvent };
