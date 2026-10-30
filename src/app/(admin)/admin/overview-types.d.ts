import type { BackupHealth } from "@/lib/backups/health-types";
import type { DatabaseSize, DatabaseUseLevel } from "@/lib/db/size-utils";

/** Everything the overview reads; a part is `null` when its request failed or the viewer may not read it. */
export type OverviewData = {
	accounts: { role: "admin" | "user"; disabled?: boolean }[] | null;
	mailboxes: { type?: "personal" | "shared" }[] | null;
	domains: { status: string; dnsSkipped?: boolean }[] | null;
	/** Pending database updates: `{ pending }` for every admin, with names for the primary admin. */
	migrations: { pending: number } | null;
	/** Primary admin only from here on. */
	databaseSize: { size: DatabaseSize | null; level: DatabaseUseLevel } | null;
	backups: BackupHealth | null;
	webhooks: { enabled: boolean; stats: { failing: number } }[] | null;
	aiErrors: { at: string }[] | null;
};

export type AttentionTone = "warning" | "error" | "info";

/** One thing to look at, in the order the list shows them. */
export type AttentionItem = {
	id: string;
	tone: AttentionTone;
	title: string;
	detail?: string;
	href: string;
	hrefLabel: string;
};

export type OverviewStat = {
	id: "accounts" | "mailboxes" | "domains" | "database";
	label: string;
	value: string;
	hint: string;
	href?: string;
	tone?: "neutral" | "warning" | "critical";
};
