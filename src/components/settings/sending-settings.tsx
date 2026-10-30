"use client";

import { useState } from "react";
import { useSendingSettings } from "@/components/compose/use-sending-settings";
import type { SendingSettings as SendingSettingsValue } from "@/components/compose/use-sending-settings-types";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UNDO_SEND_SECONDS_OPTIONS } from "@/lib/email/undo-send-utils";
import { FormError, SettingRow, SettingRows } from "@/components/ui/page";

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
		<SettingRows>
			<SettingRow
				label="Preview before sending"
				description="Show the recipients, subject and the message as it will be rendered before it goes out. AI drafts are always reviewed."
				control={
					<Switch
						checked={settings.previewEnabled}
						disabled={isLoading || saving}
						onCheckedChange={(next) => save({ previewEnabled: next })}
						aria-label="Preview before sending"
					/>
				}
			/>
			<SettingRow
				label="Undo send"
				description="Hold each message for a few seconds after you press Send, so you can take it back. Scheduled messages are not affected."
				control={
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
				}
			/>
			{(saveError || error) && <FormError className="px-4">{saveError || error}</FormError>}
		</SettingRows>
	);
}
