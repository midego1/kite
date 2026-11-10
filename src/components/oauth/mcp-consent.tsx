"use client";

import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { mcpScopeOption, scopesNeedMailboxes } from "@/components/settings/api-keys-settings-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { McpConsentDetails } from "./mcp-consent-types";
import { decideConsent, loadConsent, toggled } from "./mcp-consent-utils";

/**
 * The consent screen of an MCP app signing in with OAuth: who asks, where the browser goes back to, and the
 * permissions and mailboxes to grant, of which only reading is ticked. Nothing is granted until **Allow**.
 */
export function McpConsent({ query }: { query: string }) {
	const [details, setDetails] = useState<McpConsentDetails | null>(null);
	const [fatal, setFatal] = useState<string | null>(null);
	const [refused, setRefused] = useState<{ url: string; message: string; host: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [scopes, setScopes] = useState<string[]>([]);
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void loadConsent(query)
			.then((loaded) => {
				if (cancelled) return;
				if (loaded.kind === "redirect") setRefused(loaded);
				else if (loaded.kind === "error") setFatal(loaded.message);
				else {
					setDetails(loaded.details);
					setScopes(loaded.details.checked);
				}
			})
			.catch(() => {
				if (!cancelled) setFatal("Could not load this request. Reload the page to try again.");
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	async function decide(decision: "allow" | "deny") {
		setBusy(true);
		setError(null);
		try {
			window.location.assign(await decideConsent({ query, decision, scopes, mailboxIds }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not finish connecting the app");
			setBusy(false);
		}
	}

	if (refused)
		return (
			<AuthShell icon={PlugZap} title="This app cannot connect" description={refused.message}>
				<p className="text-sm text-neutral-600">
					Nothing was shared. Return to the app to tell it why, or start the connection again from the app.
				</p>
				<Button asChild variant="outline" className="mt-4">
					<a href={refused.url}>Return to {refused.host}</a>
				</Button>
			</AuthShell>
		);
	if (fatal)
		return (
			<AuthShell icon={PlugZap} title="This app cannot connect" description={fatal}>
				<p className="text-sm text-neutral-600">Start the connection again from the app.</p>
			</AuthShell>
		);
	if (!details)
		return (
			<AuthShell icon={PlugZap} title="Connect an app">
				<p className="text-sm text-neutral-500">Loading…</p>
			</AuthShell>
		);
	const needsMailbox = scopesNeedMailboxes("mcp", scopes);
	const canAllow = !busy && scopes.length > 0 && (!needsMailbox || mailboxIds.length > 0);
	return (
		<AuthShell
			icon={PlugZap}
			title={`Allow ${details.client.name} to use Kite?`}
			description={
				<>
					The app will act as you through MCP with the permissions you choose. It returns to{" "}
					<strong className="break-all text-neutral-900">{details.client.redirectHost}</strong>.
				</>
			}
		>
			<div className="space-y-5">
				<p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
					Kite has not verified this app&apos;s name. Only allow it if you started this connection yourself.
				</p>
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">Permissions</legend>
					{details.scopes.map((scope) => {
						const option = mcpScopeOption(scope);
						return (
							<label key={scope} className="flex items-start gap-3 py-1 text-sm">
								<Checkbox
									checked={scopes.includes(scope)}
									disabled={busy}
									onChange={(event) => setScopes((current) => toggled(current, scope, event.target.checked))}
								/>
								<span>
									<strong>{option.label}</strong>
									{option.description && <span className="block text-neutral-500">{option.description}</span>}
								</span>
							</label>
						);
					})}
				</fieldset>
				{needsMailbox && (
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Mailboxes</legend>
						{details.mailboxes.length === 0 ? (
							<p className="text-sm text-neutral-500">You have no mailboxes to share.</p>
						) : (
							details.mailboxes.map((mailbox) => (
								<label key={mailbox.id} className="flex items-center gap-3 text-sm">
									<Checkbox
										checked={mailboxIds.includes(mailbox.id)}
										disabled={busy}
										onChange={(event) => setMailboxIds((current) => toggled(current, mailbox.id, event.target.checked))}
									/>
									<span className="break-all">{mailbox.address}</span>
								</label>
							))
						)}
					</fieldset>
				)}
				<p className="text-xs text-neutral-500">
					Sending still needs your confirmation in Kite. You can revoke its access any time under Settings → MCP apps.
				</p>
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2">
					<Button type="button" variant="outline" disabled={busy} onClick={() => void decide("deny")}>
						Deny
					</Button>
					<Button type="button" disabled={!canAllow} onClick={() => void decide("allow")}>
						{busy ? "Connecting…" : "Allow"}
					</Button>
				</div>
			</div>
		</AuthShell>
	);
}
