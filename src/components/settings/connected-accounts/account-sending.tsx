"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { saveSending, sendingText } from "./connected-accounts-utils";

/**
 * The send-as part of an account row (spec §7): whether the address is in the From menu and why not, and the switches
 * "Send from this address" and "Save a copy in the provider's Sent folder".
 */
export function AccountSending({
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
	if (!account.smtp) return <p className="text-xs text-neutral-500">{sendingText(account)}</p>;

	async function save(patch: { sendEnabled?: boolean; appendSent?: boolean }) {
		setSaving(true);
		setError(null);
		try {
			await saveSending(account.id, patch);
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the account");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-2 pt-1" data-account-sending={account.address}>
			<p className="text-xs text-neutral-500">{sendingText(account)}</p>
			<div className="flex flex-wrap gap-x-6 gap-y-2">
				<label className="flex items-center gap-2 text-xs text-neutral-700">
					<Switch
						checked={account.sending.enabled}
						disabled={!usable || saving}
						onCheckedChange={(sendEnabled) => void save({ sendEnabled })}
						aria-label={`Send from ${account.address}`}
					/>
					Send from this address
				</label>
				{account.sending.providerSavesSent ? (
					<p className="text-xs text-neutral-500">
						{account.presetLabel} keeps a copy of what you send in its own Sent folder.
					</p>
				) : (
					<label className="flex items-center gap-2 text-xs text-neutral-700">
						<Switch
							checked={account.sending.appendSent}
							disabled={!usable || saving || !account.sending.enabled}
							onCheckedChange={(appendSent) => void save({ appendSent })}
							aria-label={`Save a copy in the Sent folder of ${account.address}`}
						/>
						Save a copy in the provider&apos;s Sent folder
					</label>
				)}
			</div>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
