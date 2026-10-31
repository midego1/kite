/** What parts of the app have told the startup screen so far (startup-stats.ts). */
export type StartupStats = {
	/** The signed-in account's name, once `/api/auth/me` answered. */
	sessionName?: string;
	/** Database updates waiting, once `/api/migrations/pending` answered. */
	pendingMigrations?: number;
	/** The mailboxes this account can open, once the mailbox list answered. */
	mailboxes?: number;
	/** Unread mail in the Inbox of the mailboxes in view, once the counts answered. */
	unread?: number;
};

export type StartupStepState = "done" | "running" | "todo";

export type StartupStep = {
	id: "load" | "session" | "database" | "mail" | "ready";
	label: string;
	/** The fact the step found, shown at the right; empty while unknown. */
	detail: string;
	state: StartupStepState;
	/** A found fact that needs attention (database updates waiting). */
	warn: boolean;
};

export type StartupStepsInput = {
	/** React has taken the server-rendered screen over. */
	mounted: boolean;
	/** The session check passed (AuthGuard's `ready`). */
	ready: boolean;
	/** The screen is about to give way to the app; every step is then done. */
	complete: boolean;
	version: string;
	commit: string;
	stats: StartupStats;
	/** Visible time the start took (hidden time not counted), for the last line. */
	elapsedMs: number;
};
