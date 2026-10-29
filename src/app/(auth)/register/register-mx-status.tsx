import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { RegisterMxStatusProps } from "./types";

/** The existing-MX check of the account step, and the confirmation to replace another provider's records. */
export function RegisterMxStatus({
	checking,
	recordsExist,
	replaceRecords,
	onReplaceRecordsChange,
	onRetry,
}: RegisterMxStatusProps) {
	if (checking) {
		return (
			<div className="flex items-center gap-3 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
				<LoaderCircle className="h-4 w-4 animate-spin" />
				Checking existing MX records
			</div>
		);
	}
	if (recordsExist === false) {
		return (
			<div className="flex items-center gap-3 rounded-lg border border-[#22c55e]/25 bg-[#22c55e]/10 text-[#166534] dark:text-[#86c99d] px-4 py-3 text-sm">
				<CheckCircle2 className="h-4 w-4" />
				No existing MX records found
			</div>
		);
	}
	if (recordsExist === null) {
		return (
			<Button type="button" variant="outline" className="h-10 w-full" onClick={onRetry}>
				Check MX records again
			</Button>
		);
	}
	return (
		<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a] px-4 py-4">
			<Checkbox
				checked={replaceRecords}
				onChange={(event) => onReplaceRecordsChange(event.target.checked)}
				className="mt-1"
			/>
			<span>
				<span className="flex items-center gap-2 text-sm font-medium">
					<AlertTriangle className="h-4 w-4" />
					Replace existing MX records
				</span>
				<span className="mt-1 block text-xs leading-5">
					This deletes the current mail provider&apos;s MX records and replaces them with Cloudflare Email Routing. The
					previous provider will stop receiving mail.
				</span>
			</span>
		</label>
	);
}
