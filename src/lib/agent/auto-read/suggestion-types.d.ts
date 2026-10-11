export type SuggestionKind =
	"calendar_invite" | "reply" | "summary" | "phishing" | "task" | "receipt" | "label" | "unsubscribe" | "follow_up";

export type SuggestionStatus = "open" | "accepted" | "dismissed" | "expired" | "superseded" | "auto_applied";

export type ReplySuggestionPayload = { urgency: "none" | "low" | "high" };

export type SummarySuggestionPayload = { text: string };

/** Deterministic signal ids first, then any reasons the model added. */
export type PhishingSuggestionPayload = { reasons: string[] };

export type CalendarInvitePayload = {
	uid: string;
	sequence: number;
	method: "REQUEST" | "CANCEL";
	organizer: string | null;
	start: string;
	end: string;
	tz: string | null;
	summary: string;
	location: string | null;
	repeats: boolean;
	/** A calendar date: `start` and `end` are midnights in `tz`, and `end` is exclusive. */
	allDay?: boolean;
	conflicts: { eventId: string; title: string; start: string; end: string }[];
	proposals: { start: string; end: string }[];
	organizerMatchesSender: boolean;
	authPassed: boolean;
	/** The reviewer's stored event with this UID: set for an update or a removal. */
	existingEventId?: string | null;
};

export type TaskSuggestionPayload = { title: string; dueAt?: string };

export type SuggestionPayloads = {
	calendar_invite: CalendarInvitePayload;
	reply: ReplySuggestionPayload;
	summary: SummarySuggestionPayload;
	phishing: PhishingSuggestionPayload;
	task: TaskSuggestionPayload;
	receipt: Record<string, never>;
	label: Record<string, never>;
	unsubscribe: Record<string, never>;
	follow_up: Record<string, never>;
};

/** A kind together with its payload, discriminated on `kind`. */
export type SuggestionContent = {
	[K in SuggestionKind]: { kind: K; payload: SuggestionPayloads[K] };
}[SuggestionKind];

/** A suggestion the planner wants; nothing in it runs without a user click in Suggest mode. */
export type PlannedSuggestion = SuggestionContent & {
	/** The policy rule that produced it, shown under "Why?". */
	reason: string;
	autoExecute: false;
};

export type SuggestionCount = { kind: SuggestionKind; count: number };
