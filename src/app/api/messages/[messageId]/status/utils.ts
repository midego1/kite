// "draft" is not a target: only the composer makes drafts, which are private to their author.
const allowedMessageStatuses = new Set(["received", "sent", "trash", "spam"]);

export function isAllowedMessageStatus(status: unknown): status is string {
	return typeof status === "string" && allowedMessageStatuses.has(status);
}
