"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { clearMailboxesCache } from "@/components/mailbox-provider-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	approveEveryoneWrittenTo,
	decideScreenerSender,
	fetchScreenerOverview,
	forgetScreenerSender,
	saveScreenerSettings,
} from "@/components/screener/screener-api";
import type { ScreenerMode, ScreenerOverview, ScreenerSettingsPatch } from "@/lib/screener/screener-types";
import { ScreenerSenderList } from "./screener-sender-list";
import { SettingRow, SettingRows } from "@/components/ui/page";

const MODES: { value: ScreenerMode; label: string; description: string }[] = [
	{
		value: "screener",
		label: "Hold in the Screener",
		description: "Mail from new senders waits in the Screener until you approve or deny them.",
	},
	{
		value: "inbox",
		label: "Deliver to the Inbox",
		description: "Mail from new senders arrives in the Inbox, marked as New sender.",
	},
];

export function ScreenerSettings() {
	const { selectedMailbox, setSelectedMailbox, isLoading } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [overview, setOverview] = useState<{ mailboxId: string; value: ScreenerOverview } | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [offerApproveSent, setOfferApproveSent] = useState(false);
	const [newAddress, setNewAddress] = useState("");

	async function reload(id: string) {
		const value = await fetchScreenerOverview(id);
		setOverview({ mailboxId: id, value });
	}

	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;
		void fetchScreenerOverview(mailboxId)
			.then((value) => {
				if (!cancelled) setOverview({ mailboxId, value });
			})
			.catch((error: unknown) => {
				if (!cancelled) setStatus(error instanceof Error ? error.message : "Could not load the Screener");
			});
		return () => {
			cancelled = true;
		};
	}, [mailboxId]);

	if (isLoading) return <p className="text-sm text-neutral-500">Loading inbox…</p>;
	if (!selectedMailbox || !mailboxId)
		return <p className="text-sm text-neutral-500">Select an inbox to configure the Screener.</p>;
	const current = overview?.mailboxId === mailboxId ? overview.value : null;
	if (!current) return <p className="text-sm text-neutral-500">{status ?? "Loading the Screener…"}</p>;
	if (!current.available)
		return (
			<p className="rounded-lg bg-neutral-50 p-4 text-sm text-neutral-600">
				The Screener needs database migration 0067. An admin can apply it from the database card in Admin settings.
			</p>
		);

	const id = mailboxId;
	const mailbox = selectedMailbox;
	const address = `${mailbox.localPart}@${mailbox.hostname}`;
	const disabled = !current.canManage || saving;

	async function update(patch: ScreenerSettingsPatch) {
		setSaving(true);
		setStatus(null);
		try {
			const value = await saveScreenerSettings(id, patch);
			setOverview({ mailboxId: id, value });
			clearMailboxesCache();
			setSelectedMailbox({ ...mailbox, screener: value.settings });
			if (patch.enabled === true) setOfferApproveSent(true);
			if (patch.enabled === false) setOfferApproveSent(false);
			setStatus("Saved");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Could not save the Screener settings");
		} finally {
			setSaving(false);
		}
	}

	async function approveSent() {
		setSaving(true);
		try {
			const result = await approveEveryoneWrittenTo(id);
			setOfferApproveSent(false);
			setStatus(
				result.approved === 1
					? "Approved 1 person you have written to"
					: `Approved ${result.approved} people you have written to`,
			);
			await reload(id);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Could not approve the people you have written to");
		} finally {
			setSaving(false);
		}
	}

	async function addApproved(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = newAddress.trim();
		if (!value) return;
		setSaving(true);
		if (await decideScreenerSender(id, value, "approved")) setNewAddress("");
		await reload(id).catch(() => undefined);
		setSaving(false);
	}

	async function forget(entry: string) {
		setSaving(true);
		try {
			await forgetScreenerSender(id, entry);
			await reload(id);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Could not remove the sender");
		} finally {
			setSaving(false);
		}
	}

	return (
		<SettingRows className="space-y-3">
			<SettingRow
				label={`Screen new senders for ${address}`}
				description="Only senders you approve reach the Inbox. Writing to someone approves them."
				control={
					<Switch
						checked={current.settings.enabled}
						onCheckedChange={(enabled) => void update({ enabled })}
						disabled={disabled}
						aria-label="Screen new senders"
					/>
				}
			/>
			{offerApproveSent && current.settings.enabled && (
				<div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-neutral-800">
					<p className="min-w-0 flex-1">Approve everyone this mailbox has already written to?</p>
					<Button type="button" size="sm" disabled={disabled} onClick={() => void approveSent()}>
						Approve everyone you&apos;ve written to
					</Button>
					<Button type="button" size="sm" variant="ghost" onClick={() => setOfferApproveSent(false)}>
						Not now
					</Button>
				</div>
			)}
			{current.settings.enabled && (
				<fieldset className="grid gap-2 sm:grid-cols-2" disabled={disabled}>
					<legend className="mb-2 text-sm font-medium text-neutral-900">Mail from new senders</legend>
					{MODES.map((mode) => (
						<label
							key={mode.value}
							className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500/50"
						>
							<input
								type="radio"
								name="screenerMode"
								value={mode.value}
								checked={current.settings.mode === mode.value}
								onChange={() => void update({ mode: mode.value })}
								className="mt-1 h-4 w-4 shrink-0 accent-blue-600 outline-none"
							/>
							<span className="min-w-0">
								<span className="block text-sm font-medium text-neutral-900">{mode.label}</span>
								<span className="block text-sm text-neutral-500">{mode.description}</span>
							</span>
						</label>
					))}
				</fieldset>
			)}
			{current.canManage && (
				<form onSubmit={addApproved} className="flex flex-wrap items-end gap-2">
					<div className="min-w-56 flex-1 space-y-2">
						<Label htmlFor="screenerApproveAddress">Approve a sender</Label>
						<Input
							id="screenerApproveAddress"
							type="email"
							value={newAddress}
							onChange={(event) => setNewAddress(event.target.value)}
							placeholder="name@example.com"
							disabled={saving}
						/>
					</div>
					<Button type="submit" disabled={saving || !newAddress.trim()}>
						Approve
					</Button>
				</form>
			)}
			<div className="grid gap-3 sm:grid-cols-2">
				<ScreenerSenderList
					title="Approved senders"
					emptyText="No approved senders yet."
					entries={current.approved}
					canManage={current.canManage}
					disabled={saving}
					actionLabel="Remove"
					onAction={(entry) => void forget(entry)}
				/>
				<ScreenerSenderList
					title="Denied senders"
					emptyText="No denied senders."
					entries={current.denied}
					canManage={current.canManage}
					disabled={saving}
					actionLabel="Un-deny"
					onAction={(entry) => void forget(entry)}
				/>
			</div>
			{!current.canManage && (
				<p className="text-sm text-neutral-500">Full access is required to change the Screener.</p>
			)}
			{status && (
				<p role="status" className="text-sm text-neutral-500">
					{status}
				</p>
			)}
		</SettingRows>
	);
}
