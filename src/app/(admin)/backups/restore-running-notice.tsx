import { RefreshCw } from "lucide-react";

/** Shown while a queued restore runs; the page signs in again once it is done. */
export function RestoreRunningNotice({ running }: { running: boolean }) {
	if (!running) return null;
	return (
		<p
			role="status"
			data-testid="restore-running"
			className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-4 py-3 text-sm text-neutral-700"
		>
			<RefreshCw className="h-4 w-4 animate-spin" />
			Restoring the backup. This can take a while for a large database; you will be asked to sign in again when it is
			done.
		</p>
	);
}
