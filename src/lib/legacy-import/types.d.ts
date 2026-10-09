/**
 * "full" empties this database and copies every backed-up table from the old
 * one; "catch-up" only adds rows and files that are not here yet.
 */
export type LegacyImportMode = "full" | "catch-up";

export type LegacyImportPhase = "clear" | "tables" | "files" | "done";

export type LegacyImportTableProgress = { read: number; written: number; skipped: number };

export type LegacyImportState = {
	id: string;
	mode: LegacyImportMode;
	/** SHA-256 of the token the page that started the run holds; steps authenticate with it. */
	tokenHash: string;
	step: number;
	phase: LegacyImportPhase;
	tables: string[];
	tableIndex: number;
	lastRowid: number | null;
	fileCursor: string | null;
	progress: Record<string, LegacyImportTableProgress>;
	files: { copied: number; skipped: number; bytes: number };
	problems: string[];
	unreadableSecrets: string[];
	safetyBackupKey: string | null;
	startedAt: string;
	updatedAt: string;
	finishedAt: string | null;
};

export type LegacyImportRun = Omit<LegacyImportState, "tokenHash">;

export type LegacyImportSource = {
	tables: number;
	messages: number | null;
	error?: string;
};

export type LegacyImportStatus = {
	available: boolean;
	source: LegacyImportSource | null;
	run: LegacyImportRun | null;
};

export type LegacyRoute = {
	zoneId: string;
	hostname: string;
	ruleId: string | null;
	/** The address the rule matches, or "*" for the catch-all. */
	address: string;
};

export type LegacyRoutingStatus = {
	configured: boolean;
	error?: string;
	workerName: string;
	routes: LegacyRoute[];
};

export type LegacyRoutingResult = {
	updated: number;
	failed: { route: LegacyRoute; error: string }[];
};
