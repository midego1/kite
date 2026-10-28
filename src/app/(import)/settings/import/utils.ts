import { authFetch } from "@/lib/auth/client";
import type {
	AccountPlan,
	AccountPlanFolder,
	ImapFormState,
	ImportJobFolder,
	ImportFolderSummary,
	ImportJob,
	ImportResult,
	ImportSourceItem,
	ImportSourceOption,
	ImportSourceSection,
} from "./types";

export const importSourceOptions: ImportSourceOption[] = [
	{ value: "inbox", label: "Inbox", imapFolder: "INBOX", destination: "system:inbox", system: true },
	{ value: "sent", label: "Sent", imapFolder: "Sent", destination: "system:sent", system: true },
	{ value: "drafts", label: "Drafts", imapFolder: "Drafts", destination: "system:drafts", system: true },
	{ value: "archived", label: "Archived", imapFolder: "Archive", destination: "system:archived", system: true },
	{ value: "spam", label: "Spam", imapFolder: "Spam", destination: "system:spam", system: true },
	{ value: "trash", label: "Trash", imapFolder: "Trash", destination: "system:trash", system: true },
	{ value: "others", label: "Others", imapFolder: "", destination: "system:inbox" },
];

/** The Encryption select's value: `secure` is implicit TLS, otherwise STARTTLS (there is no plain-text choice). */
export function imapSecurityValue(form: ImapFormState): "tls" | "starttls" {
	return form.secure ? "tls" : "starttls";
}

/** Switches between implicit TLS and STARTTLS, moving the port along when it is still the other one's default. */
export function withImapSecurity(form: ImapFormState, secure: boolean): ImapFormState {
	const defaults = { tls: "993", starttls: "143" };
	const port =
		form.port === (secure ? defaults.starttls : defaults.tls) ? (secure ? defaults.tls : defaults.starttls) : form.port;
	return { ...form, secure, port };
}

export function getImportSourceOption(section: ImportSourceSection): ImportSourceOption {
	return importSourceOptions.find((option) => option.value === section) ?? importSourceOptions[0];
}

export function getSelectedImportSources(sections: ImportSourceSection[]): ImportSourceItem[] {
	return sections.map((section) => {
		const option = getImportSourceOption(section);
		return {
			id: `system:${option.value}`,
			label: option.label,
			imapFolder: option.imapFolder,
			destination: option.destination,
			sourceSection: option.value,
		};
	});
}

export function getFileImportSource(sources: ImportSourceItem[]): ImportSourceItem {
	return sources.find((source) => source.id !== "system:others") ?? getSelectedImportSources(["inbox"])[0];
}

export async function ensureImportDestination(mailboxId: string, source: ImportSourceItem): Promise<string> {
	if (!source.folderName) return source.destination;
	const folders = await fetchMailboxFolders(mailboxId);
	const existing = folders.find((folder) => folder.name.toLowerCase() === source.folderName?.toLowerCase());
	if (existing) return `folder:${existing.id}`;

	const response = await authFetch("/api/folders", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, name: source.folderName }),
	});
	const data = (await response.json()) as ImportFolderSummary & { error?: string };
	if (!response.ok) throw new Error(data.error ?? `Unable to create folder ${source.folderName}`);
	return `folder:${data.id}`;
}

export async function fetchMailboxFolders(mailboxId: string): Promise<ImportFolderSummary[]> {
	const params = new URLSearchParams({ mailboxId });
	const response = await authFetch(`/api/folders?${params.toString()}`);
	const data = (await response.json()) as { folders?: ImportFolderSummary[]; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load folders");
	return data.folders ?? [];
}

export async function importFromImap(
	mailboxId: string,
	form: ImapFormState,
	destination: string,
	offset = 0,
): Promise<ImportResult> {
	const response = await authFetch("/api/import/imap", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mailboxId,
			destination,
			host: form.host,
			port: Number(form.port),
			secure: form.secure,
			username: form.username,
			password: form.password,
			folder: form.folder,
			limit: Number(form.limit),
			offset,
		}),
	});
	const data = (await response.json()) as ImportResult;
	if (!response.ok) throw new Error(data.error ?? "IMAP import failed");
	return data;
}

/** Starts a background import of one IMAP folder; the server keeps going if the page closes. */
export async function createImapImportJob(
	mailboxId: string,
	form: ImapFormState,
	destination: string,
	label: string,
	confirmDatabaseFull = false,
): Promise<ImportJob> {
	const response = await authFetch("/api/import/jobs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mailboxId,
			destination,
			label,
			host: form.host,
			port: Number(form.port),
			secure: form.secure,
			username: form.username,
			password: form.password,
			folder: form.folder,
			limit: Number(form.limit),
			importAll: form.importAll,
			confirmDatabaseFull,
		}),
	});
	const data = (await response.json()) as { job?: ImportJob; error?: string };
	if (!response.ok || !data.job) throw new Error(data.error ?? "Unable to start IMAP import");
	return data.job;
}

export async function fetchImportJobs(): Promise<ImportJob[]> {
	const response = await authFetch("/api/import/jobs");
	const data = (await response.json()) as { jobs?: ImportJob[]; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load imports");
	return data.jobs ?? [];
}

export async function cancelImportJob(id: string): Promise<void> {
	const response = await authFetch(`/api/import/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? "Unable to cancel import");
	}
}

export function isActiveImportJob(job: ImportJob): boolean {
	return job.status === "pending" || job.status === "running";
}

/** A job that stopped itself (the database is nearly full) and waits for Resume or Cancel. */
export function isPausedImportJob(job: ImportJob): boolean {
	return job.status === "paused";
}

export async function resumeImportJob(
	id: string,
	confirmDatabaseFull = false,
): Promise<"resumed" | "needs_confirmation"> {
	const response = await authFetch(`/api/import/jobs/${encodeURIComponent(id)}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirmDatabaseFull }),
	});
	if (response.ok) return "resumed";
	const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
	if (data.code === "DATABASE_NEARLY_FULL") return "needs_confirmation";
	throw new Error(data.error ?? "Unable to resume import");
}

export function getImportJobPercent(job: ImportJob): number {
	if (job.status === "completed") return 100;
	if (!job.total) return 0;
	return Math.min(100, Math.round((job.processed / job.total) * 100));
}

export function formatImportResult(result: ImportResult | null): string {
	if (!result) return "";
	return `${result.imported ?? 0} imported, ${result.skipped ?? 0} skipped`;
}

/** Messages a limited IMAP import will read across the selected sources; null for whole folders. */
export function estimatedImapMessages(form: ImapFormState, sources: number): number | null {
	return form.importAll ? null : Math.max(Number(form.limit) || 0, 0) * sources;
}

export function canSubmitImap(input: {
	form: ImapFormState;
	hasMailbox: boolean;
	sources: number;
	loading: boolean;
	/** The database is or would be above 90% of its limit and "Import anyway" is unchecked. */
	blockedBySize: boolean;
}): boolean {
	const { form } = input;
	const filled = !!form.host && !!form.username && !!form.password;
	return filled && input.hasMailbox && input.sources > 0 && !input.loading && !input.blockedBySize;
}

/** The destinations one source folder can be sent to, in the one-folder form and the mapping table. */
export const systemDestinations = [
	{ value: "system:inbox", label: "Inbox" },
	{ value: "system:sent", label: "Sent" },
	{ value: "system:archived", label: "Archive" },
	{ value: "system:spam", label: "Spam" },
	{ value: "system:trash", label: "Trash" },
];

/** Reads the source account's folders and the proposed mapping; nothing is stored. */
export async function fetchAccountPlan(form: ImapFormState): Promise<AccountPlan> {
	const response = await authFetch("/api/import/account/plan", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(imapAccountBody(form)),
	});
	const data = (await response.json()) as AccountPlan & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to read the account's folders");
	return { gmail: data.gmail, folders: data.folders };
}

function imapAccountBody(form: ImapFormState) {
	return {
		host: form.host,
		port: Number(form.port),
		secure: form.secure,
		username: form.username,
		password: form.password,
	};
}

/** Starts one background job over the folders kept in the mapping table. */
export async function createAccountImportJob(
	mailboxId: string,
	form: ImapFormState,
	folders: AccountPlanFolder[],
	confirmDatabaseFull = false,
): Promise<ImportJob> {
	const response = await authFetch("/api/import/jobs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "account", mailboxId, ...imapAccountBody(form), folders, confirmDatabaseFull }),
	});
	const data = (await response.json()) as { job?: ImportJob; error?: string };
	if (!response.ok || !data.job) throw new Error(data.error ?? "Unable to start the import");
	return data.job;
}

export async function pauseImportJob(id: string): Promise<void> {
	const response = await authFetch(`/api/import/jobs/${encodeURIComponent(id)}/pause`, { method: "POST" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? "Unable to pause import");
	}
}

/** Messages the ticked rows hold, or null while any of them is unknown (for the size estimate). */
export function plannedMessageCount(folders: AccountPlanFolder[]): number | null {
	const included = folders.filter((folder) => folder.include);
	if (!included.length) return 0;
	return included.every((folder) => folder.messages !== null)
		? included.reduce((sum, folder) => sum + (folder.messages ?? 0), 0)
		: null;
}

export function formatPlannedBytes(bytes: number | null): string {
	if (bytes === null) return "—";
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Where a job's folder went, in words for the jobs list. */
export function describeJobDestination(folder: Pick<ImportJobFolder, "destination" | "destinationName">): string {
	if (folder.destination === "gmail:labels") return "By Gmail label";
	const system = systemDestinations.find((option) => option.value === folder.destination);
	if (system) return system.label;
	return folder.destinationName ?? "Folder";
}

/** A proposed new folder that the mailbox already has becomes that folder, so the table shows it as chosen. */
export function adoptExistingFolders(plan: AccountPlan, folders: ImportFolderSummary[]): AccountPlan {
	const byName = new Map(folders.map((folder) => [folder.name.toLowerCase(), folder.id]));
	return {
		...plan,
		folders: plan.folders.map((folder) => {
			const existing = folder.destination.startsWith("new:")
				? byName.get(folder.destination.slice(4).toLowerCase())
				: undefined;
			return existing ? { ...folder, destination: `folder:${existing}` } : folder;
		}),
	};
}
