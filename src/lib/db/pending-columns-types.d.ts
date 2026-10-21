/** The part of a Drizzle column the pending-column helpers read. */
export type PendingColumn = {
	/** The SQL column name. */
	name: string;
	default?: unknown;
};
