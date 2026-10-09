"use client";

import { useState } from "react";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MailboxAutoReplySettings } from "./types";
import { updateMailboxAutoReply } from "./utils";
import { Switch } from "../ui/switch";

const defaultSettings: MailboxAutoReplySettings = {
	enabled: false,
	subject: "Out of office",
	body: "",
};

export function MailboxAutoReplyForm() {
	const { selectedMailbox, setSelectedMailbox, isLoading } = useSelectedMailbox();
	const mailboxSettings: MailboxAutoReplySettings = {
		enabled: selectedMailbox?.autoReplyEnabled ?? defaultSettings.enabled,
		subject: selectedMailbox?.autoReplySubject ?? defaultSettings.subject,
		body: selectedMailbox?.autoReplyBody ?? defaultSettings.body,
	};
	const [settings, setSettings] = useState(mailboxSettings);
	const [savedSettings, setSavedSettings] = useState(mailboxSettings);
	const [status, setStatus] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const mailboxSettingsKey = JSON.stringify([selectedMailbox?.id, mailboxSettings]);
	if (useKeyChanged(mailboxSettingsKey)) {
		setSettings(mailboxSettings);
		setSavedSettings(mailboxSettings);
		setStatus(null);
	}

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox) return;
		if (settings.enabled && !settings.body.trim()) {
			setStatus("Enter an auto-reply message before enabling it.");
			return;
		}
		setSaving(true);
		setStatus(null);
		try {
			const saved = await updateMailboxAutoReply(selectedMailbox.id, settings);
			setSettings(saved);
			setSavedSettings(saved);
			setSelectedMailbox({
				...selectedMailbox,
				autoReplyEnabled: saved.enabled,
				autoReplySubject: saved.subject,
				autoReplyBody: saved.body,
			});
			setStatus("Saved");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to update auto-reply");
		} finally {
			setSaving(false);
		}
	}

	if (isLoading) return <p className="text-sm text-neutral-500">Loading inbox…</p>;
	if (!selectedMailbox) return <p className="text-sm text-neutral-500">Select an inbox to configure auto-reply.</p>;

	const address = `${selectedMailbox.localPart}@${selectedMailbox.hostname}`;
	const canManage = selectedMailbox.permission === "full_access";
	const changed = JSON.stringify(settings) !== JSON.stringify(savedSettings);

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Enable auto-reply for {address}</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Each sender receives at most one automatic response every 24 hours.
					</span>
				</span>

				<Switch
					checked={settings.enabled}
					onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
					disabled={!canManage || saving}
				/>
			</label>
			{settings.enabled && (
				<>
					<div className="space-y-2">
						<Label htmlFor="autoReplySubject">Subject</Label>
						<Input
							id="autoReplySubject"
							value={settings.subject}
							onChange={(event) => setSettings({ ...settings, subject: event.target.value })}
							placeholder="Out of office"
							disabled={!canManage || saving}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="autoReplyBody">Message</Label>
						<Textarea
							id="autoReplyBody"
							value={settings.body}
							onChange={(event) => setSettings({ ...settings, body: event.target.value })}
							placeholder="Thanks for your message. I am currently away and will reply when I return."
							rows={7}
							disabled={!canManage || saving}
						/>
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={!canManage || saving || !changed}>
							{saving ? "Saving..." : "Save"}
						</Button>
						{!canManage && <p className="text-sm text-neutral-500">Full access is required to edit auto-reply.</p>}
						{status && <p className="text-sm text-neutral-500">{status}</p>}
					</div>
				</>
			)}
		</form>
	);
}
