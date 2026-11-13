/**
 * The reader toolbar's overflowable actions in priority order (index 0 stays longest). A phone's row holds Reply
 * and Report spam beside the fixed Delete and More actions; a wider row holds the rest, and Reply all and Snooze
 * only exist when the message can use them. Notes, where the conversation offers them, is the first to move.
 */
export function readerInlineActionIds(options: {
	isMobile: boolean;
	canReplyAll: boolean;
	snoozable: boolean;
	notes?: boolean;
}) {
	const notes = options.notes ? ["notes"] : [];
	if (options.isMobile) return ["reply", "spam", ...notes];
	const ids = options.canReplyAll ? ["replyAll", "archive"] : ["archive"];
	if (options.snoozable) ids.push("snooze");
	return [...ids, "move", "spam", "mark", ...notes];
}

/** The Notes button's name, part of the toolbar's measure key: the count changes its width. */
export function toolbarNotesLabel(notes?: { label: string }): string {
	return notes ? notes.label : "";
}
