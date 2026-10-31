"use client";

import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { AttachmentRisk } from "@/lib/email/attachment-risk-types";
import { cn } from "@/lib/utils";

/**
 * Why a file is flagged, with the "I understand the risk" box its download or copy waits for. Renders nothing for a
 * file that is not flagged. Kite has no antivirus: this warns about types that are dangerous by design.
 */
export function AttachmentRiskNotice({
	risk,
	acknowledged,
	onAcknowledgedChange,
	className,
}: {
	risk: AttachmentRisk | null;
	acknowledged: boolean;
	onAcknowledgedChange: (acknowledged: boolean) => void;
	className?: string;
}) {
	if (!risk || risk.level === "ok") return null;
	const danger = risk.level === "danger";
	const Icon = danger ? ShieldAlert : AlertTriangle;
	return (
		<div
			role="alert"
			data-attachment-risk={risk.level}
			className={cn(
				"flex shrink-0 items-start gap-3 rounded-xl border px-4 py-3 text-sm",
				danger ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900",
				className,
			)}
		>
			<Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium">{danger ? "This file can harm your computer." : "Be careful with this file."}</p>
				<ul className="mt-1 list-disc space-y-0.5 pl-5">
					{risk.reasons.map((reason) => (
						<li key={reason} className="break-words">
							{reason}
						</li>
					))}
				</ul>
				<p className="mt-1">Open it only if you expected it from someone you trust.</p>
				<label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
					<Checkbox
						checked={acknowledged}
						onChange={(event) => onAcknowledgedChange(event.target.checked)}
						data-attachment-risk-acknowledge
					/>
					I understand the risk
				</label>
			</div>
		</div>
	);
}
