"use client";

import { ChartNoAxesColumn, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ROW_BUTTON_CLASS } from "@/components/ui/page-utils";
import { TELEMETRY_DOCS_URL, telemetryHideLabel, telemetryNoticeCopy } from "@/lib/telemetry/notice-utils";
import { TELEMETRY_FIELDS, telemetryLocalStart, telemetryNoticeText } from "@/lib/telemetry/telemetry-utils";
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

/** The start moment in the browser's time zone, when that reads differently from UTC. */
function localStartText(startDay: string): string | null {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const local = zone ? telemetryLocalStart(startDay, zone) : null;
	return local && `That is ${local} in your time zone (${zone}).`;
}

/**
 * "Exactly what is sent", opened in place: the Admin page notice can sit on the very page a link would lead to, so
 * a link there would do nothing.
 */
function FieldsDisclosure() {
	const [open, setOpen] = useState(false);
	const listId = useId();
	return (
		<>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				className="mr-auto text-xs underline underline-offset-2 hover:opacity-80"
				onClick={() => setOpen((value) => !value)}
			>
				Exactly what is sent
			</button>
			<div id={listId} hidden={!open} className="basis-full text-xs">
				<ul className="space-y-1">
					{TELEMETRY_FIELDS.map(({ key, description }) => (
						<li key={key}>
							<code>{key}</code>: {description}
						</li>
					))}
				</ul>
				<a
					href={TELEMETRY_DOCS_URL}
					target="_blank"
					rel="noreferrer"
					className="mt-2 inline-block underline underline-offset-2 hover:opacity-80"
				>
					Read the privacy page
				</a>
			</div>
		</>
	);
}

/**
 * Tells the primary admin of an install that never chose (an upgrade, or a setup without the switch) that usage
 * statistics start on the start day unless they turn them off. Shown above the Admin pages only, until they choose
 * or hide it; the mail views, Settings and the module pages never show it. The start day is fixed only once the
 * notice is on screen, and hiding it keeps that day.
 */
export function TelemetryNotice() {
	const { startDay, unseen, markShown, save, endpoint } = useTelemetryNotice();
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
	const copy = telemetryNoticeCopy(endpoint);
	const localStart = localStartText(startDay);
	const hide = (
		<HideButton label={telemetryHideLabel(startDay)} disabled={busy} onClick={() => choose({ notice: "dismissed" })} />
	);
	const alert = error && (
		<p role="alert" className="mt-1 text-red-600">
			{error}
		</p>
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
				<p className="mt-1">{copy.detail}</p>
				{localStart && <p className="mt-1">{localStart}</p>}
				{alert}
				<div className="mt-4 flex flex-wrap items-center justify-end gap-3">
					<FieldsDisclosure />
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
