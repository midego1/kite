import type { LegacyImportMode, LegacyImportRun, LegacyImportState, LegacyImportTableProgress } from "./types";

export const LEGACY_IMPORT_STATE_KEY = "legacy-import/state.json";
const PROBLEM_LIMIT = 20;

/** Tables to copy, in the backup's parent-first order, limited to those both databases have. */
export function selectCopyTables(order: readonly string[], source: Set<string>, target: Set<string>): string[] {
	return order.filter((table) => source.has(table) && target.has(table));
}

/** Objects the copy leaves alone: its own state lives in the new bucket. */
export function isCopyableObjectKey(key: string): boolean {
	return !key.startsWith("legacy-import/");
}

export function createLegacyImportState(input: {
	id: string;
	mode: LegacyImportMode;
	tokenHash: string;
	tables: string[];
	safetyBackupKey: string | null;
	now: Date;
}): LegacyImportState {
	const now = input.now.toISOString();
	return {
		id: input.id,
		mode: input.mode,
		tokenHash: input.tokenHash,
		step: 0,
		phase: input.mode === "full" ? "clear" : "tables",
		tables: input.tables,
		tableIndex: 0,
		lastRowid: null,
		fileCursor: null,
		progress: Object.fromEntries(input.tables.map((table) => [table, { read: 0, written: 0, skipped: 0 }])),
		files: { copied: 0, skipped: 0, bytes: 0 },
		problems: [],
		unreadableSecrets: [],
		safetyBackupKey: input.safetyBackupKey,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
	};
}

/** Records one copied page and moves the cursor to the next page or table. */
export function recordTablePage(
	state: LegacyImportState,
	page: LegacyImportTableProgress & { lastRowid: number | null; complete: boolean },
): void {
	const table = state.tables[state.tableIndex];
	const progress = (state.progress[table] ??= { read: 0, written: 0, skipped: 0 });
	progress.read += page.read;
	progress.written += page.written;
	progress.skipped += page.skipped;
	if (page.complete) {
		state.tableIndex += 1;
		state.lastRowid = null;
		if (state.tableIndex >= state.tables.length) state.phase = "files";
	} else {
		state.lastRowid = page.lastRowid;
	}
}

export function addProblem(state: LegacyImportState, problem: string): void {
	if (state.problems.length < PROBLEM_LIMIT && !state.problems.includes(problem)) state.problems.push(problem);
}

export function toLegacyImportRun(state: LegacyImportState): LegacyImportRun {
	const { tokenHash: _tokenHash, ...run } = state;
	return run;
}

export function isLegacyImportState(value: unknown): value is LegacyImportState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LegacyImportState>;
	return (
		typeof state.id === "string" &&
		(state.mode === "full" || state.mode === "catch-up") &&
		typeof state.tokenHash === "string" &&
		typeof state.step === "number" &&
		Array.isArray(state.tables) &&
		typeof state.tableIndex === "number"
	);
}

export function totalCopiedRows(run: Pick<LegacyImportRun, "progress">): { written: number; skipped: number } {
	let written = 0;
	let skipped = 0;
	for (const progress of Object.values(run.progress)) {
		written += progress.written;
		skipped += progress.skipped;
	}
	return { written, skipped };
}

/** Settings sealed with APP_ENCRYPTION_KEY, by app_settings column, as the import report names them. */
export const SEALED_SETTING_LABELS: Record<string, string> = {
	resend_api_key: "Resend API key",
	aws_config: "AWS access keys",
	ses_receiving: "Amazon SES receiving",
	resend_webhook_secret: "Resend inbound webhook",
	agent_api_key: "Assistant provider API key",
	alert_webhook_url: "Alert webhook",
};
