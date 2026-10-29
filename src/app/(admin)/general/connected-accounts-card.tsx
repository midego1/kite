"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";

type InstallSwitch = {
	enabled: boolean;
	keyConfigured: boolean;
	disabledAt: string | null;
	migrationPending: boolean;
	accounts: number;
};

const QUERY_KEY = ["admin", "external-accounts"];

async function readSwitch(response: Response): Promise<InstallSwitch> {
	const data = (await response.json().catch(() => ({}))) as InstallSwitch & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not load connected accounts");
	return data;
}

function switchText(state: InstallSwitch): string {
	if (state.migrationPending) return "Apply the pending database update to use connected accounts.";
	if (!state.keyConfigured)
		return "Off: set APP_ENCRYPTION_KEY first. Kite only ever saves account passwords encrypted.";
	if (state.enabled) return `On. ${state.accounts} connected account${state.accounts === 1 ? "" : "s"}.`;
	return "Off. Saved accounts are paused; their passwords are erased 30 days after the switch was turned off.";
}

/** **Allow connected accounts**: the owner's install switch (spec §9.3). */
export function ConnectedAccountsCard() {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const { data } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: async () => readSwitch(await authFetch("/api/admin/external-accounts", { cache: "no-store" })),
		refetchOnWindowFocus: false,
	});

	async function change(enabled: boolean) {
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch("/api/admin/external-accounts", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			queryClient.setQueryData(QUERY_KEY, await readSwitch(response));
		} catch (changeError) {
			setError(changeError instanceof Error ? changeError.message : "Could not save");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card data-connected-accounts-switch>
			<CardHeader>
				<CardTitle>Connected accounts</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-4 text-sm text-neutral-700">
				<div className="flex items-center gap-3">
					<Switch
						id="external-accounts-enabled"
						checked={!!data?.enabled}
						onCheckedChange={(enabled) => void change(enabled)}
						disabled={!data || saving || data.migrationPending || (!data.keyConfigured && !data.enabled)}
					/>
					<label htmlFor="external-accounts-enabled" className="font-medium text-neutral-900">
						Allow connected accounts
					</label>
				</div>
				{data && <p data-connected-accounts-status>{switchText(data)}</p>}
				<p>
					Users can connect a Gmail, iCloud, Fastmail, Yahoo or other IMAP account and import its mail without typing
					the password each time. Kite stores the password encrypted with APP_ENCRYPTION_KEY, never shows it again and
					leaves it out of backups. You can take the permission away per user under Accounts → Permissions.
				</p>
				{error && (
					<p role="alert" className="text-red-600">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
