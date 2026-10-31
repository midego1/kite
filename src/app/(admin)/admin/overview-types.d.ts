import type { AdminOverviewCounts } from "@/lib/admin/overview-types";
import type { BackupHealth } from "@/lib/backups/health-types";
import type { DatabaseSize, DatabaseUseLevel } from "@/lib/db/size-utils";
import type { DirectUploadsReminderData } from "@/components/storage/direct-uploads-reminder-utils";

/** Everything the overview reads; a part is `null` while loading, when its request failed or the viewer may not read it. */
export type OverviewData = {
	/** Pending database updates: `{ pending }` for every admin, with names for the primary admin. */
	migrations: { pending: number } | null;
	counts: AdminOverviewCounts | null;
	/** Primary admin only from here on, shared with the cards under the tiles. */
	databaseSize: { size: DatabaseSize | null; level: DatabaseUseLevel } | null;
	backups: BackupHealth | null;
	/** Primary admin only: the storage overview's "Direct uploads are off" reminder. */
	directUploads?: DirectUploadsReminderData | null;
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
	/** Offers Why?, which explains the failed AI requests by cause (`AiFailuresWhy`). */
	why?: boolean;
	/** Offers Dismiss, which hides the item for the install until the cause comes back. */
	dismissible?: boolean;
};

export type OverviewStat = {
	id: "accounts" | "mailboxes" | "domains" | "database";
	label: string;
	value: string;
	hint: string;
	href?: string;
	tone?: "neutral" | "warning" | "critical";
};
