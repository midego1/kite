"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { authFetch } from "@/lib/auth/client";
import type { ExternalAccountStatus } from "@/lib/external-accounts/types";
import { STATUS_LABELS } from "@/components/settings/connected-accounts/connected-accounts-utils";

type View = {
	allowed: boolean;
	editable: boolean;
	migrationPending: boolean;
	accounts: { total: number; states: Partial<Record<ExternalAccountStatus, number>> };
};

async function readView(response: Response, fallback: string): Promise<View> {
	const data = (await response.json().catch(() => ({}))) as Partial<View> & { error?: string };
	if (!response.ok || typeof data.allowed !== "boolean") throw new Error(data.error ?? fallback);
	return data as View;
}

/** "2 connected accounts: 1 Connected, 1 Sign-in failed"; never which accounts. */
function accountSummary(accounts: View["accounts"]): string {
	const states = Object.entries(accounts.states)
		.map(([status, count]) => `${count} ${STATUS_LABELS[status as ExternalAccountStatus]}`)
		.join(", ");
	return `${accounts.total} connected account${accounts.total === 1 ? "" : "s"}: ${states}`;
}

/**
 * The **Connect accounts** permission (spec §9.3) and how many connected accounts this user has in which states:
 * admins see that they exist and how they are doing, never which accounts, their passwords or mail. Saved as soon as
 * it is ticked.
 */
export function ConnectedAccountsSection({ accountId }: { accountId: string }) {
	const [view, setView] = useState<View | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void authFetch(`/api/admin/accounts/${accountId}/connected-accounts`)
			.then((response) => readView(response, "Unable to load connected accounts"))
			.then((loaded) => active && setView(loaded))
			.catch((error) => active && setMessage(error instanceof Error ? error.message : "Unable to load"));
		return () => {
			active = false;
		};
	}, [accountId]);

	async function change(allowed: boolean) {
		setSaving(true);
		setMessage(null);
		try {
			const response = await authFetch(`/api/admin/accounts/${accountId}/connected-accounts`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ allowed }),
			});
			setView(await readView(response, "Unable to save the permission"));
			setMessage(allowed ? "Connected accounts allowed" : "Connected accounts paused for this account");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to save the permission");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section
			aria-labelledby="connected-accounts-access"
			className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 id="connected-accounts-access" className="text-sm font-semibold text-neutral-900">
						Connected accounts
					</h2>
					<p className="mt-1 text-xs text-neutral-500">
						Allow this account to connect Gmail, iCloud and other IMAP accounts. Taking it away pauses them; their saved
						passwords are erased after 30 days.
					</p>
				</div>
				<Checkbox
					aria-label="Allow connected accounts"
					checked={view?.allowed ?? false}
					disabled={!view?.editable || saving || view.migrationPending}
					onChange={(event) => void change(event.target.checked)}
				/>
			</div>
			{view?.migrationPending && (
				<p role="status" className="text-sm text-blue-900">
					Apply the pending database update to manage connected accounts.
				</p>
			)}
			{!!view?.accounts.total && <p className="text-sm text-neutral-700">{accountSummary(view.accounts)}</p>}
			{message && (
				<p role="status" className="text-sm text-neutral-500">
					{message}
				</p>
			)}
		</section>
	);
}
