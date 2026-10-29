import type { ImapImportRequest } from "../imap/types";

/** `scope: "account"`: the folders of the mapping table, each `{ sourceName, role, destination, include, messages, bytes }`. */
export type AccountImportJobRequest = ImapImportRequest & {
	scope: "account";
	label?: string;
	folders?: { include?: boolean; messages?: number | null; [key: string]: unknown }[];
	confirmDatabaseFull?: boolean;
};

export type ImapImportJobRequest = ImapImportRequest & {
	/** Import from this connected account instead of the typed host and password. */
	accountId?: unknown;
	/** Shown in the jobs list, e.g. "Sent". */
	label?: string;
	/** false imports only the newest `limit` messages. Defaults to the whole folder. */
	importAll?: boolean;
	/** "Import anyway": the database is or would be above 90% of its limit. */
	confirmDatabaseFull?: boolean;
};
