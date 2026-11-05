import { authFetch } from "@/lib/auth/client";
import { formatDatabaseBytes } from "@/lib/db/size-utils";
import type { AccountPlan, AccountPlanFolder, FolderSizeState, PlannedFolderSize, PlannedTotals } from "./types";

/** Bytes as the table and the totals show them: decimal units, like the database size, so rows and totals agree. */
export function formatPlannedBytes(bytes: number | null): string {
	return bytes === null ? "—" : formatDatabaseBytes(bytes);
}

/** Messages the ticked rows hold, or null while any of them is unknown (for the size estimate). */
function plannedMessageCount(folders: AccountPlanFolder[]): number | null {
	const included = folders.filter((folder) => folder.include);
	if (!included.length) return 0;
	return included.every((folder) => folder.messages !== null)
		? included.reduce((sum, folder) => sum + (folder.messages ?? 0), 0)
		: null;
}

/**
 * What the size of a folder is, in the table: the server's own total, a finished measurement (exact unless some messages
 * came with no size, then scaled from the ones that did), or an estimate scaled from the part measured so far.
 */
export function plannedFolderSize(folder: AccountPlanFolder, state: FolderSizeState | undefined): PlannedFolderSize {
	if (folder.bytes !== null) return { kind: "exact", bytes: folder.bytes };
	if (folder.messages === 0) return { kind: "exact", bytes: 0 };
	if (!state || state.status === "unavailable" || state.status === "failed") return { kind: "unknown" };
	const sized = state.messages - state.unsized;
	if (state.status === "done") {
		if (state.messages === 0) return { kind: "exact", bytes: 0 };
		if (state.unsized === 0) return { kind: "exact", bytes: state.bytes };
		// A server that sent no sizes says nothing; one that sent some is scaled, and called an estimate.
		return sized > 0
			? { kind: "estimated", bytes: Math.round((state.bytes / sized) * state.messages), progress: 1 }
			: { kind: "unknown" };
	}
	// A partial sum says little; scale the average message of what was counted to the folder's count, newest first.
	if (sized > 0 && folder.messages)
		return {
			kind: "estimated",
			bytes: Math.round((state.bytes / sized) * folder.messages),
			progress: state.progress,
		};
	return { kind: "measuring", progress: state.progress };
}

/** A folder to measure: its name and its message count (null when the server did not say), which bounds the steps. */
export type FolderToMeasure = { name: string; messages: number | null };

/** The ticked folders whose size the server did not report (an empty one weighs nothing), in table order. */
export function foldersToMeasure(folders: AccountPlanFolder[]): FolderToMeasure[] {
	return folders
		.filter((folder) => folder.include && folder.bytes === null && folder.messages !== 0)
		.map((folder) => ({ name: folder.sourceName, messages: folder.messages }));
}

/** Adds up the ticked rows: messages, size (exact once every row is, estimated while some are being measured). */
export function plannedTotals(folders: AccountPlanFolder[], sizes: Record<string, FolderSizeState>): PlannedTotals {
	const included = folders.filter((folder) => folder.include);
	let bytes = 0;
	let known = 0;
	let estimated = 0;
	let measuring = 0;
	let unavailable = 0;
	let failed = 0;
	for (const folder of included) {
		const state = sizes[folder.sourceName];
		const size = plannedFolderSize(folder, state);
		if (size.kind === "exact" || size.kind === "estimated") {
			bytes += size.bytes;
			known += 1;
		}
		if (size.kind === "estimated") estimated += 1;
		if (size.kind === "estimated" && size.progress < 1) measuring += 1;
		else if (size.kind === "measuring") measuring += 1;
		else if (size.kind === "unknown") {
			// No state yet means it waits its turn; a finished one with no sizes in it is as good as unavailable.
			if (state?.status === "failed") failed += 1;
			else if (state?.status === "unavailable" || state?.status === "done") unavailable += 1;
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
		failed,
	};
}

/**
 * The rows as the job request sends them: a folder with an exact size carries it, so the job's estimate has it. An
 * estimate is never sent: the start check and the page's warning use the same basis (exact sizes only).
 */
export function withMeasuredBytes(folders: AccountPlanFolder[], sizes: Record<string, FolderSizeState>) {
	return folders.map((folder) => {
		const size = plannedFolderSize(folder, sizes[folder.sourceName]);
		return size.kind === "exact" ? { ...folder, bytes: size.bytes } : folder;
	});
}

/** One step of measuring a folder; `unavailable` when the server cannot be measured this way. */
export type FolderSizeStepAnswer =
	| { unavailable: true }
	| {
			messages: number;
			bytes: number;
			unsized: number;
			uidValidity: number | null;
			nextCursor: number | null;
			done: boolean;
			progress: number;
	  };

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
			`This server did not say how big ${folders(totals.unavailable)} ${totals.unavailable === 1 ? "is" : "are"}, so the size stays unknown. The import is not affected.`,
		);
	if (totals.failed > 0)
		notes.push(
			`Measuring ${folders(totals.failed)} did not work just now, so the size stays unknown. Tick ${totals.failed === 1 ? "it" : "them"} again or read the folders again to retry. The import is not affected.`,
		);
	notes.push(
		gmail
			? "Gmail's All Mail holds every label's copy of a message once. Kite skips mail it already has (matched by Message-ID), so these totals are an upper bound."
			: "Mail that is already in Kite, or in more than one of these folders, is copied once (matched by Message-ID), so these totals are an upper bound.",
	);
	return notes;
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
