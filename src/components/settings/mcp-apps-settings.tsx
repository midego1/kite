"use client";

import { useEffect, useState } from "react";
import { PlugZap, Unplug } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useHydrated } from "@/hooks/use-hydrated";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { mcpScopeOption } from "@/components/settings/api-keys-settings-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { List, ListRow } from "@/components/ui/list";
import { EmptyState, FormError, PageHeader } from "@/components/ui/page";
import { formatUserDate } from "@/lib/time/utils";
import type { ConnectedMcpApp } from "./mcp-apps-settings-types";
import { disconnectMcpApp, loadConnectedMcpApps, mcpServerUrl } from "./mcp-apps-settings-utils";

/** Settings → MCP apps: the apps connected with OAuth instead of a pasted key, each with **Revoke**. */
export function McpAppsSettings() {
	const { mailboxes } = useSelectedMailbox();
	const [apps, setApps] = useState<ConnectedMcpApp[]>([]);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const hydrated = useHydrated();
	const serverUrl = mcpServerUrl(hydrated ? window.location.origin : "");

	useEffect(() => {
		let cancelled = false;
		void loadConnectedMcpApps()
			.then((loaded) => {
				if (cancelled) return;
				setApps(loaded.apps);
				setPending(loaded.migrationPending);
			})
			.catch((cause) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load connected apps");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function disconnect(app: ConnectedMcpApp) {
		if (
			!(await requestConfirmation({
				title: `Revoke “${app.clientName}”?`,
				description: "The app loses access at once. To use it again, connect it and approve it once more.",
				confirmLabel: "Revoke access",
			}))
		)
			return;
		setRevokingId(app.id);
		setError(null);
		try {
			await disconnectMcpApp(app.id);
			setApps((current) => current.filter((item) => item.id !== app.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not revoke the app");
		} finally {
			setRevokingId(null);
		}
	}

	const address = (id: string) => {
		const mailbox = mailboxes.find((item) => item.id === id);
		return mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : id;
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="MCP apps"
				description={
					<>
						AI apps that signed in to Kite with OAuth instead of an API key. Add <code>{serverUrl}</code> as an MCP
						server in the app; it opens Kite for you to approve it.
					</>
				}
			/>
			{error && <FormError>{error}</FormError>}
			{pending && (
				<p className="text-sm text-neutral-600">
					Connecting apps with OAuth needs a database update first; an admin can apply it from the Admin overview.
				</p>
			)}
			<section className="space-y-3">
				{loading && <SectionRowSkeleton />}
				{!loading && apps.length === 0 && (
					<EmptyState
						icon={PlugZap}
						title="No connected apps"
						description="Apps you approve when they sign in to Kite appear here, and you can revoke their access."
					/>
				)}
				{apps.length > 0 && (
					<List>
						{apps.map((app) => (
							<ListRow key={app.id} className="px-4 py-3" data-mcp-app={app.id}>
								<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
									<PlugZap className="h-4 w-4" />
								</span>
								<span className="min-w-0 flex-1 space-y-1">
									<span className="flex min-w-0 flex-wrap items-center gap-2">
										<strong className="truncate text-sm font-semibold text-neutral-900">{app.clientName}</strong>
										<Badge variant="outline">OAuth</Badge>
									</span>
									<span className="block truncate text-sm text-neutral-500">
										Returns to {app.redirectHost} · Connected {formatUserDate(app.createdAt, { dateStyle: "short" })}
										{app.lastUsedAt
											? ` · Last used ${formatUserDate(app.lastUsedAt, { dateStyle: "short" })}`
											: " · Not used yet"}
									</span>
									<span className="flex flex-wrap gap-1">
										{app.scopes.map((scope) => (
											<Badge key={scope} variant="outline">
												{mcpScopeOption(scope).label}
											</Badge>
										))}
									</span>
									<span className="block text-xs text-neutral-500">
										Mailboxes: {app.mailboxIds.map(address).join(", ") || "None"}
									</span>
								</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={revokingId === app.id}
									onClick={() => void disconnect(app)}
								>
									<Unplug className="h-4 w-4" />
									{revokingId === app.id ? "Revoking…" : "Revoke"}
								</Button>
							</ListRow>
						))}
					</List>
				)}
			</section>
		</div>
	);
}
