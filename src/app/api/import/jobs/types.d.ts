import type { ImapImportRequest } from "../imap/types";

export type ImapImportJobRequest = ImapImportRequest & {
	/** Shown in the jobs list, e.g. "Sent". */
	label?: string;
	/** false imports only the newest `limit` messages. Defaults to the whole folder. */
	importAll?: boolean;
	/** "Import anyway": the database is or would be above 90% of its limit. */
	confirmDatabaseFull?: boolean;
};
