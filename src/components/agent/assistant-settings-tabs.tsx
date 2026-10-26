"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
		<Tabs
			value={active}
			onValueChange={(value) => setTab(value as TabId)}
			className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 text-sm"
		>
			<TabsList aria-label="Assistant settings" className="flex">
				{TABS.map((item) => (
					<TabsTrigger key={item.id} value={item.id} disabled={item.id === "activity" && !mailboxId} className="flex-1">
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
			<TabsContent value="settings" forceMount hidden={active !== "settings"} className="space-y-4">
				{children}
			</TabsContent>
			{mailboxId && (
				<TabsContent value="activity" className="space-y-3">
					<Link href="/kite-activity" className="text-xs text-blue-700 underline-offset-2 hover:underline">
						Open the Activity page
					</Link>
					<AgentActivity key={mailboxId} mailboxId={mailboxId} />
				</TabsContent>
			)}
		</Tabs>
	);
}
