"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { saveAssistantAvailability } from "@/lib/agent/availability-client";
import { AutoReadAdminSettings } from "@/components/agent/auto-read-admin-settings";
import { AgentProviders } from "./agent-providers";
import { RecentAiErrors } from "./recent-ai-errors";
import type { AgentAdminSettingsResponse } from "./types";
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
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold tracking-tight text-neutral-900">Agent</h1>
					<p className="mt-1 text-sm text-neutral-500">
						Choose the AI provider and models used by the email assistant for chat and drafts.
					</p>
				</div>
				<Button asChild variant="outline" className="shrink-0">
					<Link href="/ai-usage">View Usage</Link>
				</Button>
			</div>
			<Card>
				<CardContent className="flex items-center justify-between gap-4 p-0">
					<div>
						<p className="font-medium text-neutral-900">Enable assistant</p>
						<p className="mt-1 text-sm text-neutral-500">
							Show assistant chat and allow automatic drafts for everyone.
						</p>
					</div>
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
									setEnabledStatus(error instanceof Error ? error.message : "Could not update assistant availability"),
								)
								.finally(() => setEnabledSaving(false));
						}}
						aria-label="Enable assistant"
					/>
				</CardContent>
				{enabledStatus && (
					<p role="status" className="mt-3 text-sm text-red-700">
						{enabledStatus}
					</p>
				)}
			</Card>
			{loadError && (
				<p role="status" className="text-sm text-red-700">
					{loadError}
				</p>
			)}
			{data && <AgentProviders data={data} onChange={setData} />}
			<AutoReadAdminSettings />
			<RecentAiErrors />
		</div>
	);
}
