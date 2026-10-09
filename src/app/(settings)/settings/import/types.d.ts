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

export type ImapFormState = {
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

export type ImportJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
	errors: string[];
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};
