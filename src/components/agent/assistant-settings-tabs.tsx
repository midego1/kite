"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AgentActivity } from "./agent-activity";

const TABS = [
	{ id: "settings", label: "Settings" },
	{ id: "activity", label: "Activity" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** The assistant settings view: the settings form, and Kite's Activity for the mailbox being edited. */
export function AssistantSettingsTabs({
	settings,
	children,
}: {
	settings: { mailboxId: string } | null;
	children: ReactNode;
}) {
	const [tab, setTab] = useState<TabId>("settings");
	const mailboxId = settings?.mailboxId ?? null;
	const active: TabId = mailboxId ? tab : "settings";
	return (
		<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 text-sm">
			<div role="tablist" aria-label="Assistant settings" className="flex gap-1 rounded-xl bg-neutral-100 p-1">
				{TABS.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						id={`assistant-settings-tab-${item.id}`}
						aria-selected={active === item.id}
						aria-controls={`assistant-settings-panel-${item.id}`}
						disabled={item.id === "activity" && !mailboxId}
						className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50 ${active === item.id ? "bg-white text-blue-700 shadow-sm" : "text-neutral-600 hover:text-neutral-900"}`}
						onClick={() => setTab(item.id)}
					>
						{item.label}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id="assistant-settings-panel-settings"
				aria-labelledby="assistant-settings-tab-settings"
				hidden={active !== "settings"}
				className="space-y-4"
			>
				{children}
			</div>
			{active === "activity" && mailboxId && (
				<div
					role="tabpanel"
					id="assistant-settings-panel-activity"
					aria-labelledby="assistant-settings-tab-activity"
					className="space-y-3"
				>
					<Link href="/kite-activity" className="text-xs text-blue-700 underline-offset-2 hover:underline">
						Open the Activity page
					</Link>
					<AgentActivity key={mailboxId} mailboxId={mailboxId} />
				</div>
			)}
		</div>
	);
}
