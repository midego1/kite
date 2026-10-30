/** The storage overview's `directUploadsReminder`: whether to remind the owner, and the last automatic attempt. */
export type DirectUploadsReminderData = {
	show: boolean;
	setup: { ok: boolean; source: "install" | "admin"; message?: string; permission?: string | null } | null;
};

export const DIRECT_UPLOADS_REMINDER_TITLE = "Direct uploads are off: set up (2 min)";

export const DIRECT_UPLOADS_WHY =
	"Large Drive uploads pass through the Worker. With direct uploads they go straight to R2: faster, and less load on the Worker.";

/** Why the last automatic setup did not finish, in one sentence; nothing when it never ran or worked. */
export function directUploadsAttemptText(setup: DirectUploadsReminderData["setup"]): string | null {
	if (!setup || setup.ok) return null;
	const when = setup.source === "install" ? "during installation" : "last time";
	const permission = setup.permission ? ` CF_TOKEN needs "${setup.permission}".` : "";
	return `The automatic setup ${when} did not finish: ${setup.message ?? "it failed"}${permission}`;
}
