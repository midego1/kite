import type {
	AttachmentReclaimCounts,
	AttachmentStorageCounts,
	SharedObjectCounts,
} from "@/lib/email/attachment-storage-types";
import type { AttachmentStorageJobView } from "@/lib/email/attachment-storage-jobs-types";

/** `GET /api/admin/attachment-storage`. */
export interface AttachmentStorageReport extends AttachmentStorageCounts {
	shared: SharedObjectCounts;
	/** Null before migration 0088. */
	reclaim: AttachmentReclaimCounts | null;
	job: AttachmentStorageJobView | null;
	/** False until migrations 0088 and 0090 are applied. */
	jobsReady: boolean;
	switches: { rawIndex: boolean; sharing: boolean };
}

export type AttachmentStorageAction = "reclaim" | "materialize" | "cancel";
