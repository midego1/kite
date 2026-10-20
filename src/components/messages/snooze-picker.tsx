"use client";

import { useId, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getUserTimeZone } from "@/lib/time/utils";
import { formatSnoozePresetHint, getSnoozePresets, snoozeMessage } from "./message-list-row-actions-utils";
import type { SnoozeMenuItemProps, SnoozePickerProps } from "./types";

/** A Snooze entry for a hand-rolled menu that expands into the picker below it. */
export function SnoozeMenuItem({ messageId, expanded, onExpandedChange, onSnoozed }: SnoozeMenuItemProps) {
	return (
		<div data-snooze-expanded={expanded}>
			<button
				type="button"
				className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
				aria-expanded={expanded}
				onClick={() => onExpandedChange(!expanded)}
			>
				<Clock className="h-4 w-4" />
				Snooze
				<ChevronDown
					className={`ml-auto h-4 w-4 text-neutral-400 transition-transform ${expanded ? "rotate-180" : ""}`}
				/>
			</button>
			{expanded && (
				<div className="mb-1 ml-3 border-l border-neutral-100 pl-1">
					<SnoozePicker messageId={messageId} onSnoozed={onSnoozed} />
				</div>
			)}
		</div>
	);
}

export function SnoozePicker({ messageId, onSnoozed }: SnoozePickerProps) {
	const inputId = useId();
	const [presets] = useState(() => getSnoozePresets());
	const [customValue, setCustomValue] = useState(() => presets[0].value);
	const [snoozing, setSnoozing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function snooze(value: string) {
		setSnoozing(true);
		setError(null);
		try {
			await snoozeMessage(messageId, value);
			onSnoozed();
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Unable to snooze message");
		} finally {
			setSnoozing(false);
		}
	}

	return (
		<div role="group" aria-label="Snooze until" className="text-sm">
			{presets.map((preset) => (
				<button
					key={preset.label}
					type="button"
					disabled={snoozing}
					onClick={() => void snooze(preset.value)}
					className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-neutral-700 hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none disabled:text-neutral-400"
				>
					<span>{preset.label}</span>
					<span className="ml-auto text-xs text-neutral-500">{formatSnoozePresetHint(preset.value)}</span>
				</button>
			))}
			<form
				className="mt-1 space-y-2 border-t border-neutral-100 px-3 pb-1 pt-2"
				onSubmit={(event) => {
					event.preventDefault();
					void snooze(customValue);
				}}
			>
				<label htmlFor={inputId} className="block text-xs font-medium text-neutral-500">
					Pick date &amp; time ({getUserTimeZone()})
				</label>
				<input
					id={inputId}
					type="datetime-local"
					value={customValue}
					onChange={(event) => setCustomValue(event.target.value)}
					className="h-9 w-full rounded-md border border-neutral-200 bg-transparent px-2 text-sm outline-none focus:border-blue-400"
				/>
				{error && (
					<p role="alert" className="text-xs text-red-600">
						{error}
					</p>
				)}
				<Button type="submit" size="sm" className="w-full" disabled={snoozing}>
					{snoozing ? "Snoozing..." : "Snooze"}
				</Button>
			</form>
		</div>
	);
}
