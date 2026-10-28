"use client";

import Link from "next/link";
import { ChartNoAxesColumn, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NOTICE_LINK_CLASS, WARNING_NOTICE_CLASS } from "@/components/notice-styles";
import { TELEMETRY_NOTICE_DETAIL } from "@/lib/telemetry/notice-utils";
import { telemetryNoticeText } from "@/lib/telemetry/telemetry-utils";
import { useTelemetryNotice, type TelemetryUpdate } from "./use-telemetry-status";

function DismissButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
	return (
		<button
			type="button"
			aria-label="Dismiss"
			title="Dismiss"
			disabled={disabled}
			className="-mr-1.5 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[#f59e0b]/15"
			onClick={onClick}
		>
			<X className="h-3.5 w-3.5" aria-hidden="true" />
		</button>
	);
}

/**
 * Tells the primary admin of an install that never chose (an upgrade, or a setup without the switch) that usage
 * statistics start on the stored start day unless they turn them off. Shown until they choose or dismiss it, in the
 * sidebar notice slot and above the admin pages; dismissing keeps the start day.
 */
export function TelemetryNotice({ variant }: { variant: "sidebar" | "page" }) {
	const { startDay, save } = useTelemetryNotice();
	const [error, setError] = useState<string | null>(null);
	if (!startDay) return null;

	const choose = (update: TelemetryUpdate) => {
		setError(null);
		save.mutate(update, {
			onError: (failure) => setError(failure instanceof Error ? failure.message : "Could not save usage statistics"),
		});
	};
	const busy = save.isPending;
	const lead = telemetryNoticeText(startDay);
	const alert = error && (
		<p role="alert" className="mt-1 text-red-600">
			{error}
		</p>
	);

	if (variant === "sidebar")
		return (
			<section aria-label="Usage statistics notice" data-telemetry-notice className={WARNING_NOTICE_CLASS}>
				<ChartNoAxesColumn className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">Usage statistics</p>
					<p className="mt-0.5 opacity-90">{lead}</p>
					{alert}
					<div className="mt-1.5 flex flex-wrap items-center gap-3">
						<button
							type="button"
							className={NOTICE_LINK_CLASS}
							disabled={busy}
							onClick={() => choose({ enabled: false })}
						>
							Turn off
						</button>
						<button
							type="button"
							className={NOTICE_LINK_CLASS}
							disabled={busy}
							onClick={() => choose({ enabled: true })}
						>
							Keep on
						</button>
						<Link href="/general" className={NOTICE_LINK_CLASS}>
							Details
						</Link>
					</div>
				</div>
				<DismissButton disabled={busy} onClick={() => choose({ notice: "dismissed" })} />
			</section>
		);

	return (
		<section
			aria-label="Usage statistics notice"
			data-telemetry-notice
			className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"
		>
			<ChartNoAxesColumn className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium">{lead}</p>
				<p className="mt-1">{TELEMETRY_NOTICE_DETAIL}</p>
				{alert}
				<div className="mt-4 flex flex-wrap items-center justify-end gap-3">
					<Link
						href="/general"
						className="mr-auto text-xs text-amber-800 underline underline-offset-2 hover:text-amber-900"
					>
						Exactly what is sent
					</Link>
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => choose({ enabled: false })}>
						Turn off
					</Button>
					<Button type="button" size="sm" disabled={busy} onClick={() => choose({ enabled: true })}>
						Keep on
					</Button>
				</div>
			</div>
			<DismissButton disabled={busy} onClick={() => choose({ notice: "dismissed" })} />
		</section>
	);
}
