import { authFetch } from "@/lib/auth/client";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import type {
	AccountPlan,
	AccountPlanFolder,
	FolderSizeState,
	ImapFormState,
	ImportJobFolder,
	ImportFolderSummary,
	ImportJob,
	ImportResult,
	ImportSourceAccount,
	ImportSourceItem,
	ImportSourceOption,
	ImportSourceSection,
	PlannedFolderSize,
	PlannedTotals,
} from "./types";
import { formatDatabaseBytes } from "@/lib/db/size-utils";

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
			...imapAccountBody(form),
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
			...imapAccountBody(form),
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

/** A connected account is chosen, or the server, user name and password are filled in. */
export function hasImapSource(form: ImapFormState): boolean {
	return !!form.accountId || (!!form.host && !!form.username && !!form.password);
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
	const filled = hasImapSource(form);
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

/** The source of a request: a connected account by id, or the server and password typed into the form. */
export function imapAccountBody(form: ImapFormState) {
	if (form.accountId) return { accountId: form.accountId };
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
function plannedMessageCount(folders: AccountPlanFolder[]): number | null {
	const included = folders.filter((folder) => folder.include);
	if (!included.length) return 0;
	return included.every((folder) => folder.messages !== null)
		? included.reduce((sum, folder) => sum + (folder.messages ?? 0), 0)
		: null;
}

/** A size in the table and under it: the same decimal units as the database size, so rows and totals agree. */
export function formatPlannedBytes(bytes: number | null): string {
	return bytes === null ? "—" : formatDatabaseBytes(bytes);
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

/** The user's connected accounts that can be imported from now; none when connected accounts are off or unavailable. */
export async function fetchImportSourceAccounts(): Promise<ImportSourceAccount[]> {
	const response = await authFetch("/api/external-accounts", { cache: "no-store" });
	if (!response.ok) return [];
	const data = (await response.json().catch(() => ({}))) as {
		accounts?: ExternalAccountView[];
		refusal?: string | null;
	};
	if (data.refusal || !Array.isArray(data.accounts)) return [];
	return data.accounts
		.filter((account) => account.status === "active")
		.map((account) => ({
			id: account.id,
			address: account.address,
			label: account.label,
			mailboxId: account.mailboxId,
		}));
}

/** What the size of folder `folder` is, in the table: the server's own total, a finished measurement, or progress. */
export function plannedFolderSize(folder: AccountPlanFolder, state: FolderSizeState | undefined): PlannedFolderSize {
	if (folder.bytes !== null) return { kind: "exact", bytes: folder.bytes };
	if (folder.messages === 0) return { kind: "exact", bytes: 0 };
	if (!state || state.status === "unavailable") return { kind: "unknown" };
	if (state.status === "done") return { kind: "exact", bytes: state.bytes };
	// A partial sum says little; scale the average message of what was counted to the folder's count, newest first.
	if (state.messages > 0 && folder.messages)
		return {
			kind: "estimated",
			bytes: Math.round((state.bytes / state.messages) * folder.messages),
			progress: state.progress,
		};
	return { kind: "measuring", progress: state.progress };
}

/** The ticked folders whose size the server did not report, so the page measures them (in table order). */
export function foldersToMeasure(folders: AccountPlanFolder[]): string[] {
	return folders
		.filter((folder) => folder.include && folder.bytes === null && !!folder.messages)
		.map((folder) => folder.sourceName);
}

/** Adds up the ticked rows: messages, size (exact once every row is, estimated while some are being measured). */
export function plannedTotals(folders: AccountPlanFolder[], sizes: Record<string, FolderSizeState>): PlannedTotals {
	const included = folders.filter((folder) => folder.include);
	let bytes = 0;
	let known = 0;
	let estimated = 0;
	let measuring = 0;
	let unavailable = 0;
	for (const folder of included) {
		const state = sizes[folder.sourceName];
		const size = plannedFolderSize(folder, state);
		if (size.kind === "exact" || size.kind === "estimated") {
			bytes += size.bytes;
			known += 1;
		}
		if (size.kind === "estimated") estimated += 1;
		if (size.kind === "estimated" || size.kind === "measuring") measuring += 1;
		else if (size.kind === "unknown") {
			// No state yet means it waits its turn, unless there is nothing to measure it by (no message count).
			if (state?.status === "unavailable" || !folder.messages) unavailable += 1;
			else measuring += 1;
		}
	}
	const complete = included.length > 0 && known === included.length;
	return {
		messages: plannedMessageCount(folders),
		bytes: complete ? bytes : null,
		sizeKind: !complete ? "unknown" : estimated ? "estimated" : "exact",
		measuring,
		unavailable,
	};
}

/** The rows as the job request sends them: a folder measured to the end carries its size, so the job's estimate has it. */
export function withMeasuredBytes(folders: AccountPlanFolder[], sizes: Record<string, FolderSizeState>) {
	return folders.map((folder) => {
		const size = plannedFolderSize(folder, sizes[folder.sourceName]);
		return size.kind === "exact" ? { ...folder, bytes: size.bytes } : folder;
	});
}

/** One step of measuring a folder; `unavailable` when the server cannot be measured this way. */
export type FolderSizeStepAnswer =
	| { unavailable: true }
	| { messages: number; bytes: number; nextCursor: number | null; done: boolean; progress: number };

export async function fetchFolderSizeStep(
	source: Record<string, unknown>,
	folder: string,
	cursor: number | null,
	signal?: AbortSignal,
): Promise<FolderSizeStepAnswer> {
	const response = await authFetch("/api/import/account/sizes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...source, folder, cursor }),
		signal,
	});
	const data = (await response.json()) as FolderSizeStepAnswer & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to measure the folder");
	return data;
}

/**
 * @public Exercised by the unit tests. The lines under the totals: measuring still going, folders that could not be
 * measured, and why totals are upper bounds.
 */
export function importSizeNotes(totals: PlannedTotals, gmail: boolean): string[] {
	const folders = (count: number) => `${count} folder${count === 1 ? "" : "s"}`;
	const notes: string[] = [];
	if (totals.measuring > 0)
		notes.push(
			`Still measuring ${folders(totals.measuring)}. The size is an estimate until that is done; you can start the import at any time.`,
		);
	if (totals.unavailable > 0)
		notes.push(
			`This server could not say how big ${folders(totals.unavailable)} ${totals.unavailable === 1 ? "is" : "are"}, so ${totals.unavailable === 1 ? "it is" : "they are"} not in the size. The import is not affected.`,
		);
	notes.push(
		gmail
			? "Gmail's All Mail holds every label's copy of a message once. Kite skips mail it already has (matched by Message-ID), so these totals are an upper bound."
			: "Mail that is already in Kite, or in more than one of these folders, is copied once (matched by Message-ID), so these totals are an upper bound.",
	);
	return notes;
}

/** A plan belongs to the account it was read from: another account, server, user name or port makes it stale. */
export function planIsStale(previous: ImapFormState, next: ImapFormState): boolean {
	return (
		next.accountId !== previous.accountId ||
		next.host !== previous.host ||
		next.username !== previous.username ||
		next.port !== previous.port
	);
}

/** How many folders the mapping table has ticked. */
export function includedFolderCount(plan: AccountPlan | null): number {
	return plan?.folders.filter((folder) => folder.include).length ?? 0;
}

/** What the size notice shows for the page: the totals of a plan (always) or only the warning for a single folder. */
export function sizeNoticeProps(totals: PlannedTotals | null, plan: AccountPlan | null, messages: number | null) {
	return {
		messages,
		rawBytes: totals?.bytes ?? null,
		sizeKind: totals?.sizeKind ?? ("unknown" as const),
		showTotals: !!totals,
		notes: totals && plan ? importSizeNotes(totals, plan.gmail) : [],
	};
}
