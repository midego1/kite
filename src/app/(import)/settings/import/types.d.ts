export type ImportResult = {
	imported?: number;
	skipped?: number;
	errors?: string[];
	error?: string;
	total?: number;
	nextOffset?: number | null;
	/** Background jobs started by an IMAP import. */
	queued?: number;
};

/** `account`: the whole account through the mapping table; `folder`: one source folder into one place. */
export type ImapImportMode = "account" | "folder";

export type ImapFormState = {
	mode: ImapImportMode;
	/** A connected account to import from; when set, the server fields and the password are not used. */
	accountId: string;
	/** One-folder mode: where the folder goes (`system:<status>`). */
	destination: string;
	host: string;
	port: string;
	secure: boolean;
	username: string;
	password: string;
	folder: string;
	limit: string;
	importAll: boolean;
};

export type ImportSourceSection = "inbox" | "sent" | "drafts" | "archived" | "spam" | "trash" | "others";

export type ImportSourceOption = {
	value: ImportSourceSection;
	label: string;
	imapFolder: string;
	destination: string;
	system?: boolean;
};

export type ImportTab = "file" | "imap";

export type ImportSourceItem = {
	id: string;
	label: string;
	imapFolder: string;
	destination: string;
	folderName?: string;
	sourceSection?: ImportSourceSection;
};

export type ImportFolderSummary = {
	id: string;
	name: string;
};

export type ImportProgress = {
	completed: number;
	label: string;
	total: number;
};

export type ImportJobStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type ImportJob = {
	id: string;
	mailboxId: string;
	label: string;
	folder: string;
	host: string;
	username: string;
	status: ImportJobStatus;
	total: number | null;
	processed: number;
	imported: number;
	skipped: number;
	lastError: string | null;
	attempts: number;
	errors: string[];
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	scope: "folder" | "account";
	pauseReason: string | null;
	folders: ImportJobFolder[];
};

export type ImportFolderRole = "inbox" | "sent" | "archive" | "junk" | "trash" | "all" | "user";

/** One folder of a whole-account job, as `GET /api/import/jobs` reports it. */
export type ImportJobFolder = {
	sourceName: string;
	role: ImportFolderRole;
	destination: string;
	/** The Kite folder's name when `destination` is `folder:<id>`. */
	destinationName: string | null;
	status: "pending" | "running" | "completed" | "skipped" | "failed";
	total: number | null;
	totalBytes: number | null;
	processed: number;
	imported: number;
	skipped: number;
	multiLabel: number;
	lastError: string | null;
};

/** One row of the mapping table (`POST /api/import/account/plan`). */
export type AccountPlanFolder = {
	sourceName: string;
	displayName: string;
	role: ImportFolderRole;
	include: boolean;
	/** `system:<status>`, `folder:<id>`, `new:<name>` or `gmail:labels`. */
	destination: string;
	messages: number | null;
	bytes: number | null;
};

/** Where measuring one folder's size stands (`POST /api/import/account/sizes`, for servers without STATUS=SIZE). */
export type FolderSizeState = {
	status: "measuring" | "done" | "unavailable";
	/** Messages and bytes counted so far; the totals once `done`. */
	messages: number;
	bytes: number;
	/** Share (0 to 1) of the folder's UID range covered. */
	progress: number;
};

/** The size of one table row as shown: from STATUS, measured, still being measured (an estimate) or not known. */
export type PlannedFolderSize =
	| { kind: "exact"; bytes: number }
	| { kind: "estimated"; bytes: number; progress: number }
	| { kind: "measuring"; progress: number }
	| { kind: "unknown" };

/** The ticked rows added up for the totals under the table. */
export type PlannedTotals = {
	/** Null while any ticked folder's count is unknown. */
	messages: number | null;
	/** Bytes of the ticked folders, or null while any of them has no size or estimate yet. */
	bytes: number | null;
	sizeKind: "exact" | "estimated" | "unknown";
	/** Ticked folders still being measured. */
	measuring: number;
	/** Ticked folders the server could not measure. */
	unavailable: number;
};

export type AccountPlan = { gmail: boolean; folders: AccountPlanFolder[] };

/** A connected account offered as the import source. */
/** `mailboxId` is where the account's mail goes; an import from it starts in that mailbox. */
export type ImportSourceAccount = { id: string; address: string; label: string; mailboxId: string };
