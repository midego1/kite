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

export type AccountPlan = { gmail: boolean; folders: AccountPlanFolder[] };

/** A connected account offered as the import source. */
export type ImportSourceAccount = { id: string; address: string; label: string };
