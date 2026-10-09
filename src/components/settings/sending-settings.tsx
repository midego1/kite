"use client";

import { useState } from "react";
import { useSendingSettings } from "@/components/compose/use-sending-settings";
import type { SendingSettings as SendingSettingsValue } from "@/components/compose/use-sending-settings-types";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UNDO_SEND_SECONDS_OPTIONS } from "@/lib/email/undo-send-utils";

export function SendingSettings() {
	const { settings, error, isLoading, update } = useSendingSettings();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	function save(patch: Partial<SendingSettingsValue>) {
		setSaving(true);
		setSaveError(null);
		void update(patch)
			.catch((updateError) =>
				setSaveError(updateError instanceof Error ? updateError.message : "Failed to update sending settings"),
			)
			.finally(() => setSaving(false));
	}

	return (
		<div className="space-y-3">
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Preview before sending</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Show the recipients, subject and the message as it will be rendered before it goes out. AI drafts are always
						reviewed.
					</span>
				</span>
				<Switch
					checked={settings.previewEnabled}
					disabled={isLoading || saving}
					onCheckedChange={(next) => save({ previewEnabled: next })}
					aria-label="Preview before sending"
				/>
			</label>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Undo send</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Hold each message for a few seconds after you press Send, so you can take it back. Scheduled messages are
						not affected.
					</span>
				</span>
				<Select
					value={String(settings.undoSeconds)}
					disabled={isLoading || saving}
					onChange={(event) => save({ undoSeconds: Number(event.target.value) })}
					aria-label="Undo send window"
					className="h-9 text-sm"
				>
					{UNDO_SEND_SECONDS_OPTIONS.map((seconds) => (
						<option key={seconds} value={seconds}>
							{seconds === 0 ? "Off" : `${seconds} seconds`}
						</option>
					))}
				</Select>
			</label>
			{(saveError || error) && <p className="px-4 text-sm text-red-600">{saveError || error}</p>}
		</div>
	);
}
