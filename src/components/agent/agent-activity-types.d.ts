/** One `agent_actions` row as `GET /api/agent/actions` returns it. */
export type ActivityAction = {
	id: string;
	initiator: "agent" | "user";
	action: string;
	variant: string;
	/** For a row recording an undo: the id of the action it undid. */
	undoOf: string | null;
	status: "pending" | "applied" | "undone" | "blocked" | "failed";
	reason: string | null;
	suggestionId: string | null;
	messageId: string | null;
	after: Record<string, unknown> | null;
	undoUntil: string | null;
	undoneAt: string | null;
	createdAt: string;
	canUndo: boolean;
	subject: string | null;
	/** Whether this viewer can open the row's draft (it exists, is still a draft and is theirs). */
	draftAvailable: boolean;
};

/** A triage job that never ran, with the machine reason it was skipped. */
export type ActivitySkippedJob = {
	id: string;
	reason: string | null;
	sourceMessageId: string;
	subject: string | null;
	createdAt: string;
};

export type ActivityResponse = { actions: ActivityAction[]; skippedJobs: ActivitySkippedJob[] };

export type ActivityTarget = { href: string; label: string };

export type ActivityLoadState =
	| { state: "loading" }
	| { state: "no-access" }
	| { state: "error"; message: string }
	| { state: "ready"; data: ActivityResponse };
