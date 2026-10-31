"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { saveAccountSwitches } from "./connected-accounts-utils";

/**
 * "Also sync the Spam folder" on an account row (spec §6.3), off by default: the provider's Spam folder is checked
 * with the Inbox, from the moment it is turned on, and what it brings in always lands in Kite's Spam.
 */
export function AccountSpamSync({
	account,
	usable,
	onChanged,
}: {
	account: ExternalAccountView;
	usable: boolean;
	onChanged: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save(syncJunk: boolean) {
		setSaving(true);
		setError(null);
		try {
			await saveAccountSwitches(account.id, { syncJunk });
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the account");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-1 pt-1" data-account-spam-sync={account.address}>
			<label className="flex items-center gap-2 text-xs text-neutral-700">
				<Switch
					checked={account.sync.junk}
					disabled={!usable || saving}
					onCheckedChange={(syncJunk) => void save(syncJunk)}
					aria-label={`Also sync the Spam folder of ${account.address}`}
				/>
				Also sync the Spam folder
			</label>
			<p className="text-xs text-neutral-500">
				{account.sync.junk
					? `New mail in ${account.presetLabel}'s Spam folder arrives in Kite's Spam, so you can rescue what it got wrong.`
					: "Off: only the Inbox is checked."}
			</p>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
