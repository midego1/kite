/**
 * Which list rows carry a real attachment. A row stands for one message, or in conversation view for every
 * message of its thread in the folder; it is flagged when any of them has one. `withAttachments` holds the ids
 * of messages that do.
 */
export function rowsWithAttachments<Row extends { id: string }>(
	rows: readonly Row[],
	idsFor: (row: Row) => readonly string[],
	withAttachments: ReadonlySet<string>,
): Set<string> {
	const flagged = new Set<string>();
	for (const row of rows) {
		if (idsFor(row).some((id) => withAttachments.has(id))) flagged.add(row.id);
	}
	return flagged;
}
