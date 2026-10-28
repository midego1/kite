/** The role of a source folder in a whole-account import (`import_job_folders.role`). */
export type ImportFolderRole = "inbox" | "sent" | "archive" | "junk" | "trash" | "all" | "user";

/** One row of the mapping table the import page shows before an account import starts. */
export type PlannedImportFolder = {
	/** The name as the server spells it, for EXAMINE. */
	sourceName: string;
	/** Decoded and flattened, as a Kite folder would be named. */
	displayName: string;
	role: ImportFolderRole;
	/** Copied unless the user unticks it; spam and trash start unticked. */
	include: boolean;
	/** `system:<status>`, `new:<folder name>` or `gmail:labels`. */
	destination: string;
};

/** A folder the user chose to copy, as the job request carries it. */
export type AccountFolderRequest = {
	sourceName: string;
	role: ImportFolderRole;
	destination: string;
	/** The message count the plan reported, as the folder's first total; null when unknown. Advisory only. */
	messages: number | null;
	/** The size the plan reported, for the job's estimate; null when the server did not say. */
	bytes: number | null;
};
