"use client";

import Link from "next/link";
import { ChartNoAxesColumn, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ROW_BUTTON_CLASS } from "@/components/ui/page-utils";
import { NOTICE_LINK_CLASS, WARNING_NOTICE_CLASS } from "@/components/notice-styles";
import { TELEMETRY_NOTICE_DETAIL, TELEMETRY_NOTICE_SHORT, telemetryHideLabel } from "@/lib/telemetry/notice-utils";
import { telemetryNoticeText } from "@/lib/telemetry/telemetry-utils";
import { useTelemetryNotice, useWhenVisible, type TelemetryUpdate } from "./use-telemetry-status";

function HideButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
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
 * statistics start on the start day unless they turn them off. Shown until they choose or hide it, in one place per
 * page: the sidebar notice slot in the mail views and Settings, and above the page on Admin (whose frame then leaves
 * the sidebar one out). The start day is fixed only once the notice is on screen, and hiding it keeps that day.
 */
export function TelemetryNotice({ variant }: { variant: "sidebar" | "page" }) {
	const { startDay, unseen, markShown, save } = useTelemetryNotice();
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLElement>(null);
	useWhenVisible(ref, unseen, markShown);
	if (!startDay) return null;

	const choose = (update: TelemetryUpdate) => {
		setError(null);
		save.mutate(update, {
			onError: (failure) => setError(failure instanceof Error ? failure.message : "Could not save usage statistics"),
		});
	};
	const busy = save.isPending;
	const lead = telemetryNoticeText(startDay);
	const hide = (
		<HideButton label={telemetryHideLabel(startDay)} disabled={busy} onClick={() => choose({ notice: "dismissed" })} />
	);
	const alert = error && (
		<p role="alert" className="mt-1 text-red-600">
			{error}
		</p>
	);

	if (variant === "sidebar")
		return (
			<section ref={ref} aria-label="Usage statistics notice" data-telemetry-notice className={WARNING_NOTICE_CLASS}>
				<ChartNoAxesColumn className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">Usage statistics</p>
					<p className="mt-0.5 opacity-90">{lead}</p>
					<p className="mt-0.5 opacity-90">{TELEMETRY_NOTICE_SHORT}</p>
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
				{hide}
			</section>
		);

	return (
		<section
			ref={ref}
			aria-label="Usage statistics notice"
			data-telemetry-notice
			className="mb-6 flex items-start gap-3 rounded-xl border border-[#f59e0b]/25 bg-[#f59e0b]/10 p-5 text-sm text-[#8a4b0a] dark:text-[#d4a35a]"
		>
			<ChartNoAxesColumn className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium">{lead}</p>
				<p className="mt-1">{TELEMETRY_NOTICE_DETAIL}</p>
				{alert}
				<div className="mt-4 flex flex-wrap items-center justify-end gap-3">
					<Link href="/general" className="mr-auto text-xs underline underline-offset-2 hover:opacity-80">
						Exactly what is sent
					</Link>
					{/* The two choices look the same: neither is the suggested one. */}
					<Button
						type="button"
						size="sm"
						variant="outline"
						className={ROW_BUTTON_CLASS}
						disabled={busy}
						onClick={() => choose({ enabled: false })}
					>
						Turn off
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className={ROW_BUTTON_CLASS}
						disabled={busy}
						onClick={() => choose({ enabled: true })}
					>
						Keep on
					</Button>
				</div>
			</div>
			{hide}
		</section>
	);
}
