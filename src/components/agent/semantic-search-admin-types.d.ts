export type SemanticSearchCounts = {
	pending: number;
	running: number;
	indexed: number;
	skipped: number;
	failed: number;
	eligibleUnqueued: number;
};

export type SemanticSearchSettings = {
	enabled: boolean;
	embeddingProvider: "workers_ai" | "compatible" | null;
	compatibleBaseUrl: string | null;
	backfillCursor: { createdAt: number; id: string } | null;
	backfillPaused: boolean;
	backfillCapShare: number;
};

export type SemanticSearchStatus = {
	ready: boolean;
	settings: SemanticSearchSettings;
	counts: SemanticSearchCounts;
	estimatedCostUsd: number | null;
};
