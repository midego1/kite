"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { saveAssistantAvailability } from "@/lib/agent/availability-client";
import { AutoReadAdminSettings } from "@/components/agent/auto-read-admin-settings";
import { AgentProviders } from "./agent-providers";
import { RecentAiErrors } from "./recent-ai-errors";
import type { AgentAdminSettingsResponse } from "./types";
import { PageHeader, SettingRow } from "@/components/ui/page";
import { loadAgentAdminSettings, saveAgentEnabled } from "./utils";

export default function AdminAgentPage() {
	const [data, setData] = useState<AgentAdminSettingsResponse | null>(null);
	const [assistantEnabled, setAssistantEnabled] = useState(true);
	const [enabledSaving, setEnabledSaving] = useState(false);
	const [enabledStatus, setEnabledStatus] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void loadAgentAdminSettings()
			.then((loaded) => {
				if (!active) return;
				setData(loaded);
				setAssistantEnabled(loaded.assistantEnabled);
			})
			.catch((error) => {
				if (active) setLoadError(error instanceof Error ? error.message : "Could not load agent settings");
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Agent"
				description="Choose the AI provider and models used by the email assistant for chat and drafts."
				actions={
					<Button asChild variant="outline">
						<Link href="/ai-usage">View usage</Link>
					</Button>
				}
			/>
			<Card>
				<SettingRow
					label="Enable assistant"
					description="Show assistant chat and allow automatic drafts for everyone."
					control={
						<Switch
							checked={assistantEnabled}
							disabled={!data || enabledSaving}
							onCheckedChange={(checked) => {
								setEnabledSaving(true);
								setEnabledStatus(null);
								void saveAgentEnabled(checked)
									.then((saved) => {
										setAssistantEnabled(saved.assistantEnabled);
										saveAssistantAvailability(saved.assistantEnabled);
									})
									.catch((error) =>
										setEnabledStatus(
											error instanceof Error ? error.message : "Could not update assistant availability",
										),
									)
									.finally(() => setEnabledSaving(false));
							}}
							aria-label="Enable assistant"
						/>
					}
				/>
				{enabledStatus && (
					<Notice tone="error" className="mt-3">
						{enabledStatus}
					</Notice>
				)}
			</Card>
			{loadError && <Notice tone="error">{loadError}</Notice>}
			{data && <AgentProviders data={data} onChange={setData} />}
			<AutoReadAdminSettings />
			<RecentAiErrors />
		</div>
	);
}
