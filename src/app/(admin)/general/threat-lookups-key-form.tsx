"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import type { AbuseChKeyStatus } from "@/lib/spam/providers/abuse-ch-types";
import { removeThreatLookupKey, saveThreatLookupKey } from "./utils";

type Props = {
	status: AbuseChKeyStatus;
	onStatusChange: (status: AbuseChKeyStatus) => void;
};

/** Save, replace or remove the key kept in Kite. A secret wins, so this is shown only without one. */
export function ThreatLookupsKeyForm({ status, onStatusChange }: Props) {
	const [authKey, setAuthKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const saved = status.source === "settings";

	async function run(action: () => Promise<string>) {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			setMessage(await action());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not update the key");
		} finally {
			setBusy(false);
		}
	}

	const save = () =>
		run(async () => {
			const result = await saveThreatLookupKey(authKey);
			setAuthKey("");
			onStatusChange(result.status);
			return result.warning ?? "Key works and is saved";
		});

	const remove = () =>
		run(async () => {
			const confirmed = await requestConfirmation({
				title: "Remove the abuse.ch Auth-Key?",
				description: "URLhaus and ThreatFox lookups stop until a key is saved again.",
				confirmLabel: "Remove key",
			});
			if (!confirmed) return "";
			onStatusChange(await removeThreatLookupKey());
			return "Key removed";
		});

	return (
		<div className="space-y-2" data-threat-lookups-key-form>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Label htmlFor="abuse-ch-auth-key">{saved ? "Replace the abuse.ch Auth-Key" : "abuse.ch Auth-Key"}</Label>
				<div className="flex flex-wrap gap-2">
					<Input
						id="abuse-ch-auth-key"
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={authKey}
						onChange={(event) => setAuthKey(event.target.value)}
						disabled={busy || status.updatePending}
						className="max-w-xs"
					/>
					<Button type="submit" size="sm" disabled={busy || !authKey.trim() || status.updatePending}>
						{busy ? "Checking…" : "Save key"}
					</Button>
					{saved && (
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
							Remove key
						</Button>
					)}
				</div>
			</form>
			{status.updatePending && (
				<p className="text-neutral-500">
					Apply the pending database updates from the admin overview before saving a key here.
				</p>
			)}
			{status.unreadable && (
				<p className="text-neutral-500">
					The saved key cannot be read because APP_ENCRYPTION_KEY is missing or has changed. Save the key again.
				</p>
			)}
			{message && (
				<p role="status" data-key-message>
					{message}
				</p>
			)}
			{error && (
				<p role="alert" className="text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
