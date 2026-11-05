import type { SessionUser } from "@/lib/auth/types";

import type { HostAiSource } from "@/lib/modules/host-types";

export type CalendarToolContext = {
	env: CloudflareEnv;
	user: SessionUser;
	timeZone?: string;
	/** In the chat: which events stay away from the assistant ("No AI for this mailbox", `moduleHost.mail.aiHidden`). */
	aiHidden?: (sources: readonly HostAiSource[]) => Promise<boolean[]>;
};
export type CalendarToolName =
	| "get_schedule"
	| "search_events"
	| "get_event"
	| "create_event"
	| "update_events"
	| "delete_events"
	| "find_free_time"
	| "get_calendars";
