import type { JsonValue } from "@/lib/modules/module-types";
import { parseCalendarOccurrenceId } from "./recurrence";

const MAX_REFS = 20;

const eventRef = (id: string): JsonValue => ({
	kind: "calendar:event",
	id: parseCalendarOccurrenceId(id)?.seriesId ?? id,
});

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns a tool result into plain JSON, since a database row carries `Date` values the call contract refuses. */
export function toJsonOutput(value: unknown): JsonValue {
	return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as JsonValue;
}

/** Adds the record refs of the events a calendar tool created, changed or read, so chat can link them. */
export function withCalendarToolRefs(name: string, output: JsonValue): JsonValue {
	if (!isObject(output)) return output;
	if (name === "create_event" && typeof output.eventId === "string")
		return { ...output, ref: eventRef(output.eventId) };
	if (name === "update_events" && Array.isArray(output.eventIds))
		return {
			...output,
			refs: output.eventIds
				.filter((id): id is string => typeof id === "string")
				.slice(0, MAX_REFS)
				.map(eventRef),
		};
	const event = name === "get_event" ? output.event : null;
	if (event && isObject(event) && typeof event.id === "string") return { ...output, ref: eventRef(event.id) };
	return output;
}
