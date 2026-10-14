import { z } from "zod";
import type {
	CoreSuggestionContent,
	CoreSuggestionKind,
	SuggestionContent,
	SuggestionKind,
	SuggestionPayloads,
	TaskSuggestionPayload,
} from "./suggestion-types";

export const SUGGESTION_EXPIRY_DAYS = 14;
const TITLE_MAX_CHARS = 200;

const isoDate = z.iso.datetime({ offset: true });

/**
 * Text limits count Unicode code points, the same convention triage truncation uses, so an emoji
 * (two UTF-16 units) never pushes a truncated model summary over its limit.
 */
function text(min: number, max: number) {
	// Named, because each bundle names an anonymous function differently and the coverage merge counts those as extra.
	return z.string().refine(function withinCodePoints(value) {
		const length = Array.from(value).length;
		return length >= min && length <= max;
	});
}
const empty = z.object({});

export const calendarInviteSchema = z.object({
	uid: text(1, 1_000),
	sequence: z.number().int().min(0),
	method: z.enum(["REQUEST", "CANCEL"]),
	organizer: text(0, 320).nullable(),
	start: isoDate,
	end: isoDate,
	tz: text(0, 100).nullable(),
	summary: text(0, 500),
	location: text(0, 500).nullable(),
	repeats: z.boolean(),
	allDay: z.boolean().optional(),
	conflicts: z.array(z.object({ eventId: z.string(), title: text(0, 500), start: isoDate, end: isoDate })).max(20),
	proposals: z.array(z.object({ start: isoDate, end: isoDate })).max(5),
	organizerMatchesSender: z.boolean(),
	authPassed: z.boolean(),
	existingEventId: z.string().nullable().optional(),
});

const PAYLOAD_SCHEMAS: { [K in CoreSuggestionKind]: z.ZodType<SuggestionPayloads[K]> } = {
	calendar_invite: calendarInviteSchema,
	reply: z.object({ urgency: z.enum(["none", "low", "high"]) }),
	summary: z.object({ text: text(1, 280) }),
	phishing: z.object({ reasons: z.array(text(1, 60)).min(1).max(20) }),
	task: z.object({ title: text(1, 120), dueAt: isoDate.optional() }),
	receipt: empty as z.ZodType<Record<string, never>>,
	label: empty as z.ZodType<Record<string, never>>,
	unsubscribe: empty as z.ZodType<Record<string, never>>,
	follow_up: empty as z.ZodType<Record<string, never>>,
};

function isCoreKind(kind: string): kind is CoreSuggestionKind {
	return Object.hasOwn(PAYLOAD_SCHEMAS, kind);
}

type ParsedPayload<K extends SuggestionKind> = K extends CoreSuggestionKind
	? SuggestionPayloads[K]
	: Record<string, unknown>;

/**
 * Validates a stored or planned payload against its kind's schema; null when it does not match. A kind
 * core does not know is checked against `moduleSchema`, the owning descriptor's input schema, and is
 * null without one.
 */
export function parseSuggestionPayload<K extends SuggestionKind>(
	kind: K,
	value: unknown,
	moduleSchema?: z.ZodType | null,
): ParsedPayload<K> | null {
	const schema = isCoreKind(kind) ? PAYLOAD_SCHEMAS[kind] : moduleSchema;
	const parsed = schema?.safeParse(value);
	return parsed?.success ? (parsed.data as ParsedPayload<K>) : null;
}

function cap(title: string): string {
	const chars = Array.from(title.replace(/\s+/g, " ").trim());
	return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join("")}…` : chars.join("");
}

function inviteTitle(payload: SuggestionPayloads["calendar_invite"]): string {
	const name = payload.summary.trim() || "Untitled event";
	if (payload.method === "CANCEL") return `Cancelled: ${name}`;
	const [conflict] = payload.conflicts;
	return conflict ? `${name} conflicts with ${conflict.title.trim() || "another event"}` : `Invitation: ${name}`;
}

function taskTitle(payload: TaskSuggestionPayload): string {
	return payload.dueAt ? `Due ${payload.dueAt.slice(0, 10)}: ${payload.title}` : `To do: ${payload.title}`;
}

const STATIC_TITLES: Record<CoreSuggestionKind, string> = {
	calendar_invite: "Invitation",
	reply: "Reply drafted",
	summary: "Summary",
	phishing: "This message looks like phishing",
	task: "To do",
	receipt: "Receipt or invoice",
	label: "Suggested folder",
	unsubscribe: "Unsubscribe?",
	follow_up: "No reply yet",
};

function coreTitle(suggestion: CoreSuggestionContent): string {
	if (suggestion.kind === "calendar_invite") return cap(inviteTitle(suggestion.payload));
	if (suggestion.kind === "task") return cap(taskTitle(suggestion.payload));
	return STATIC_TITLES[suggestion.kind];
}

const FALLBACK_TITLE = "Suggestion";

/**
 * The card title (at most 200 characters): the title a module step supplied, else the one code builds
 * for a core kind, else the module kind's `label`.
 */
export function suggestionTitle(suggestion: SuggestionContent & { title?: string }, label?: string | null): string {
	const supplied = suggestion.title ? cap(suggestion.title) : "";
	if (supplied) return supplied;
	if (isCoreKind(suggestion.kind)) return coreTitle(suggestion as CoreSuggestionContent);
	return cap(label ?? "") || FALLBACK_TITLE;
}

export function suggestionExpiresAt(createdAt: Date): Date {
	return new Date(createdAt.getTime() + SUGGESTION_EXPIRY_DAYS * 24 * 60 * 60_000);
}
