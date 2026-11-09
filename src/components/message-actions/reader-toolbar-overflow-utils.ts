/**
 * The reader toolbar's overflowable actions in priority order (index 0 stays longest). A phone's row holds Reply
 * and Report spam beside the fixed Delete and More actions; a wider row holds the rest, and Reply all and Snooze
 * only exist when the message can use them.
 */
export function readerInlineActionIds(options: { isMobile: boolean; canReplyAll: boolean; snoozable: boolean }) {
	if (options.isMobile) return ["reply", "spam"];
	const ids = options.canReplyAll ? ["replyAll", "archive"] : ["archive"];
	if (options.snoozable) ids.push("snooze");
	return [...ids, "move", "spam", "mark"];
}
