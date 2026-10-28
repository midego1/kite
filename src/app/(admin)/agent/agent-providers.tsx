"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { AgentProviderConnection } from "@/lib/agent/provider-types";
import { ProviderForm } from "./provider-form";
import { SavedProviders } from "./saved-providers";
import type { AgentAdminSettingsResponse, AgentProviderEditTarget } from "./types";
import { activateAgentProvider, agentProviderForm, deleteAgentProvider, initialEditTarget } from "./utils";

type AgentProvidersProps = {
	data: AgentAdminSettingsResponse;
	onChange: (data: AgentAdminSettingsResponse) => void;
};

/** The saved providers and the editor for one of them, or the single provider before migration 0077. */
export function AgentProviders({ data, onChange }: AgentProvidersProps) {
	const confirm = useConfirm();
	const [target, setTarget] = useState<AgentProviderEditTarget>(() => initialEditTarget(data));
	// Bumped on every save or switch so the editor reopens on the stored values.
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const editing = target.kind === "saved" ? data.providers.find((provider) => provider.id === target.id) : undefined;
	// A saved provider that disappeared (deleted in another tab) falls back to the one in use.
	const shown: AgentProviderEditTarget = target.kind === "saved" && !editing ? initialEditTarget(data) : target;
	const shownProvider =
		shown.kind === "saved" ? data.providers.find((provider) => provider.id === shown.id) : undefined;
	const source =
		shown.kind === "new" ? null : (shownProvider ?? { ...data.config, name: "", models: data.config.models });

	function update(next: AgentAdminSettingsResponse, message: string | null, nextTarget?: AgentProviderEditTarget) {
		onChange(next);
		setStatus(message);
		if (nextTarget) setTarget(nextTarget);
		setRevision((value) => value + 1);
	}

	async function run(action: () => Promise<void>) {
		setBusy(true);
		setStatus(null);
		try {
			await action();
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Could not update AI providers");
		} finally {
			setBusy(false);
		}
	}

	const use = (provider: AgentProviderConnection) =>
		run(async () =>
			update(await activateAgentProvider(provider.id), `Now using ${provider.name}.`, {
				kind: "saved",
				id: provider.id,
			}),
		);

	const remove = (provider: AgentProviderConnection) =>
		run(async () => {
			const confirmed = await confirm({
				title: `Delete ${provider.name}?`,
				description:
					"Its API key and model settings are deleted. Mailboxes using one of its models fall back to the default.",
				confirmLabel: "Delete provider",
			});
			if (!confirmed) return;
			const next = await deleteAgentProvider(provider.id);
			update(
				next,
				`${provider.name} deleted.`,
				target.kind === "saved" && target.id === provider.id ? initialEditTarget(next) : undefined,
			);
		});

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Bot className="h-5 w-5" />
					AI provider
				</CardTitle>
				<CardDescription>
					Email content is sent to the selected provider when someone uses the assistant. Sending a draft still requires
					human approval.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6 pt-4">
				{data.providersReady ? (
					<SavedProviders
						providers={data.providers}
						editingId={shown.kind === "saved" ? shown.id : null}
						busy={busy}
						onUse={use}
						onEdit={(provider) => {
							setStatus(null);
							setTarget({ kind: "saved", id: provider.id });
						}}
						onDelete={remove}
						onAdd={() => {
							setStatus(null);
							setTarget({ kind: "new" });
						}}
					/>
				) : (
					<p className="text-xs text-amber-700">
						Apply the pending database update to save more than one provider and switch between them.
					</p>
				)}
				{status && (
					<p role="status" className="text-sm text-neutral-700">
						{status}
					</p>
				)}
				<div className="space-y-4">
					{data.providersReady && (
						<h3 className="text-sm font-medium text-neutral-900">
							{shown.kind === "new" ? "New provider" : shownProvider ? `Edit ${shownProvider.name}` : "Provider in use"}
						</h3>
					)}
					<ProviderForm
						key={`${JSON.stringify(shown)}:${revision}`}
						target={shown}
						initial={agentProviderForm(source)}
						hasSavedKey={source?.hasApiKey ?? false}
						cloudflareAvailable={data.cloudflareAvailable}
						providersReady={data.providersReady}
						onSaved={(next, message) => {
							const added = next.providers.find(
								(provider) => !data.providers.some((existing) => existing.id === provider.id),
							);
							update(
								next,
								message,
								added ? { kind: "saved", id: added.id } : shown.kind === "active" ? initialEditTarget(next) : undefined,
							);
						}}
						onCancel={shown.kind === "new" ? () => setTarget(initialEditTarget(data)) : undefined}
					/>
				</div>
			</CardContent>
		</Card>
	);
}
