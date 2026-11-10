"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import type { MicrosoftClientStatus } from "@/lib/external-accounts/types";

const QUERY_KEY = ["admin", "external-accounts", "microsoft"];
const ENDPOINT = "/api/admin/external-accounts/microsoft";

async function readStatus(response: Response): Promise<{ status: MicrosoftClientStatus; warning?: string }> {
	const data = (await response.json().catch(() => ({}))) as {
		status?: MicrosoftClientStatus;
		warning?: string;
		error?: string;
	} & Partial<MicrosoftClientStatus>;
	if (!response.ok) throw new Error(data.error ?? "Could not load Microsoft sign-in");
	// GET answers the status itself; PUT and DELETE wrap it.
	return { status: data.status ?? (data as MicrosoftClientStatus), warning: data.warning };
}

function statusText(status: MicrosoftClientStatus): string {
	if (status.migrationPending) return "Apply the pending database update to set up Microsoft sign-in.";
	if (status.source === "env")
		return `On, from the MICROSOFT_OAUTH_* variables: application ${status.clientId}, tenant ${status.tenant}.`;
	if (status.source === "settings") return `On: application ${status.clientId}, tenant ${status.tenant}.`;
	if (status.unreadable)
		return "The saved registration cannot be read because APP_ENCRYPTION_KEY is missing or has changed. Save it again.";
	return "Off. Outlook.com and Microsoft 365 accounts can only forward their mail to Kite.";
}

/**
 * **Microsoft sign-in** (spec §15.1): the owner's own Microsoft Entra app registration, so users can connect
 * Outlook.com and Microsoft 365 accounts. The client secret is checked with Microsoft, saved sealed and never shown
 * again. Steps are in docs/providers.md.
 */
export function MicrosoftSignInForm() {
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: async () => (await readStatus(await authFetch(ENDPOINT, { cache: "no-store" }))).status,
		refetchOnWindowFocus: false,
	});
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [tenant, setTenant] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	async function run(action: () => Promise<string>) {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			setMessage(await action());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save");
		} finally {
			setBusy(false);
		}
	}

	const save = () =>
		run(async () => {
			const result = await readStatus(
				await authFetch(ENDPOINT, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ clientId, clientSecret, tenant }),
				}),
			);
			setClientSecret("");
			queryClient.setQueryData(QUERY_KEY, result.status);
			return result.warning ?? "Saved. Users can now connect Microsoft accounts.";
		});

	const remove = () =>
		run(async () => {
			const confirmed = await requestConfirmation({
				title: "Remove Microsoft sign-in?",
				description:
					"Connected Microsoft accounts stop syncing and sending when their current access runs out, and new ones cannot be connected until you save a registration again.",
				confirmLabel: "Remove",
			});
			if (!confirmed) return "";
			const result = await readStatus(await authFetch(ENDPOINT, { method: "DELETE" }));
			queryClient.setQueryData(QUERY_KEY, result.status);
			return "Microsoft sign-in removed.";
		});

	if (!data) return null;
	const editable = data.source !== "env" && !data.migrationPending && data.keyConfigured;
	return (
		<section className="space-y-3 border-t border-neutral-200 pt-4" data-microsoft-sign-in-settings>
			<h3 className="font-medium text-neutral-900">Microsoft sign-in</h3>
			<p data-microsoft-sign-in-status>{statusText(data)}</p>
			<p>
				Lets users connect Outlook.com, Hotmail and Microsoft 365 accounts, which only sign in with Microsoft. Register
				an app in Microsoft Entra with this redirect URI, then enter its IDs and a client secret here.
			</p>
			<div className="space-y-1">
				<Label htmlFor="microsoft-redirect-uri">Redirect URI (Web)</Label>
				<Input
					id="microsoft-redirect-uri"
					readOnly
					value={data.redirectUri}
					onFocus={(event) => event.currentTarget.select()}
				/>
				{!data.appUrlSet && (
					<p className="text-xs text-neutral-500">
						APP_URL is not set, so this is the address you opened Kite at. Set APP_URL to the public HTTPS address
						first; Microsoft only accepts http for localhost.
					</p>
				)}
			</div>
			{!data.keyConfigured && data.source !== "env" && (
				<p className="text-neutral-500">Set APP_ENCRYPTION_KEY first: Kite only saves the client secret encrypted.</p>
			)}
			{editable && (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-1">
							<Label htmlFor="microsoft-client-id">Application (client) ID</Label>
							<Input
								id="microsoft-client-id"
								value={clientId}
								placeholder={data.clientId ?? "00000000-0000-0000-0000-000000000000"}
								onChange={(event) => setClientId(event.target.value)}
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="microsoft-tenant">Tenant</Label>
							<Input
								id="microsoft-tenant"
								value={tenant}
								placeholder={data.tenant ?? "common"}
								onChange={(event) => setTenant(event.target.value)}
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
					</div>
					<div className="space-y-1">
						<Label htmlFor="microsoft-client-secret">Client secret (Value)</Label>
						<Input
							id="microsoft-client-secret"
							type="password"
							value={clientSecret}
							onChange={(event) => setClientSecret(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
						<p className="text-xs text-neutral-500">
							Tenant: common for work, school and personal accounts; your tenant ID for one organisation only.
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
							{busy ? "Checking…" : data.source === "settings" ? "Replace" : "Save"}
						</Button>
						{data.source === "settings" && (
							<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
								Remove
							</Button>
						)}
					</div>
				</form>
			)}
			{message && (
				<p role="status" data-microsoft-sign-in-message>
					{message}
				</p>
			)}
			{error && (
				<p role="alert" className="text-red-600">
					{error}
				</p>
			)}
		</section>
	);
}
