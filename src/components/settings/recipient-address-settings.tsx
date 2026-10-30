"use client";

import { useState } from "react";
import { useShowFullRecipientAddresses } from "@/components/messages/use-show-full-recipient-addresses";
import { Switch } from "@/components/ui/switch";
import { FormError, SettingRow } from "@/components/ui/page";

export function RecipientAddressSettings() {
	const { enabled, error, isLoading, setEnabled } = useShowFullRecipientAddresses();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	return (
		<SettingRow
			label="Show full recipient addresses"
			description="On To, Cc, and Bcc, show Name <user@domain.tld> when the message includes a name. Off shows only the email address. This follows your sign-in, on every mailbox."
			control={
				<Switch
					checked={enabled}
					disabled={isLoading || saving}
					onCheckedChange={(next) => {
						setSaving(true);
						setSaveError(null);
						void setEnabled(next)
							.catch((updateError) =>
								setSaveError(
									updateError instanceof Error ? updateError.message : "Failed to update recipient address settings",
								),
							)
							.finally(() => setSaving(false));
					}}
					aria-label="Show full recipient addresses"
				/>
			}
		>
			{(saveError || error) && <FormError className="mt-2 px-4">{saveError || error}</FormError>}
		</SettingRow>
	);
}
