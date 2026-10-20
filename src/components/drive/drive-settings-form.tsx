"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DRIVE_LINK_MAX_DAYS_LIMIT } from "@/lib/drive/link-utils";
import { DRIVE_MAX_TRASH_DAYS } from "@/lib/drive/settings-utils";
import type { DriveSettingsValues } from "@/lib/drive/types";
import { driveRequest } from "./drive-api";
import { parseQuotaGb, quotaToGb } from "./drive-utils";

type Form = { quotaGb: string; linksOn: boolean; linkMaxDays: string; trashRetentionDays: string };

const toForm = (settings: DriveSettingsValues): Form => ({
	quotaGb: quotaToGb(settings.defaultQuotaBytes),
	linksOn: settings.linkMaxDays > 0,
	linkMaxDays: String(settings.linkMaxDays || 30),
	trashRetentionDays: String(settings.trashRetentionDays),
});

function toPatch(form: Form): { patch: DriveSettingsValues } | { error: string } {
	const quota = parseQuotaGb(form.quotaGb);
	if ("error" in quota) return quota;
	const linkDays = Number(form.linkMaxDays);
	if (
		form.linksOn &&
		(!form.linkMaxDays.trim() || !Number.isInteger(linkDays) || linkDays < 1 || linkDays > DRIVE_LINK_MAX_DAYS_LIMIT)
	)
		return { error: `Enter a link lifetime from 1 to ${DRIVE_LINK_MAX_DAYS_LIMIT} days` };
	const trashDays = Number(form.trashRetentionDays);
	if (
		!form.trashRetentionDays.trim() ||
		!Number.isInteger(trashDays) ||
		trashDays < 1 ||
		trashDays > DRIVE_MAX_TRASH_DAYS
	)
		return { error: `Enter a trash retention from 1 to ${DRIVE_MAX_TRASH_DAYS} days` };
	return {
		patch: {
			defaultQuotaBytes: quota.bytes,
			linkMaxDays: form.linksOn ? linkDays : 0,
			trashRetentionDays: trashDays,
		},
	};
}

/** The install's Drive defaults: quota, public link lifetime and trash retention. */
export function DriveSettingsForm({ onSaved }: { onSaved: (settings: DriveSettingsValues) => void }) {
	const [form, setForm] = useState<Form | null>(null);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	useEffect(() => {
		driveRequest<{ settings: DriveSettingsValues }>("/api/drive/settings")
			.then(({ settings }) => setForm(toForm(settings)))
			.catch((error: unknown) =>
				setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not load settings" }),
			);
	}, []);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!form) return;
		const built = toPatch(form);
		if ("error" in built) return setStatus({ tone: "error", text: built.error });
		setSaving(true);
		setStatus(null);
		try {
			const { settings } = await driveRequest<{ settings: DriveSettingsValues }>("/api/drive/settings", {
				method: "PATCH",
				body: built.patch,
			});
			setForm(toForm(settings));
			onSaved(settings);
			setStatus({ tone: "ok", text: "Drive settings saved" });
		} catch (error) {
			setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save settings" });
		} finally {
			setSaving(false);
		}
	}

	const update = (change: Partial<Form>) => setForm((current) => current && { ...current, ...change });

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>Defaults</CardTitle>
			</CardHeader>
			<CardContent className="pt-6">
				<form onSubmit={(event) => void save(event)} className="space-y-5" data-drive-settings>
					<div className="space-y-2">
						<Label htmlFor="drive-quota">Storage per account (GB)</Label>
						<Input
							id="drive-quota"
							inputMode="decimal"
							placeholder="Unlimited"
							value={form?.quotaGb ?? ""}
							onChange={(event) => update({ quotaGb: event.target.value })}
							disabled={!form || saving}
							className="max-w-40"
						/>
						<p className="text-sm text-neutral-500">Leave empty for unlimited. An override per account beats it.</p>
					</div>
					<div className="space-y-2">
						<label className="flex items-center gap-2 text-sm font-medium text-neutral-900">
							<input
								type="checkbox"
								checked={form?.linksOn ?? false}
								onChange={(event) => update({ linksOn: event.target.checked })}
								disabled={!form || saving}
							/>
							Allow public links
						</label>
						<Label htmlFor="drive-link-days">Longest link lifetime (days)</Label>
						<Input
							id="drive-link-days"
							type="number"
							min={1}
							max={365}
							value={form?.linkMaxDays ?? ""}
							onChange={(event) => update({ linkMaxDays: event.target.value })}
							disabled={!form?.linksOn || saving}
							className="max-w-40"
						/>
						<p className="text-sm text-neutral-500">
							Every link expires: 1 to 365 days. Turning links off stops all existing links too.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="drive-trash-days">Keep trashed items for (days)</Label>
						<Input
							id="drive-trash-days"
							type="number"
							min={1}
							max={DRIVE_MAX_TRASH_DAYS}
							value={form?.trashRetentionDays ?? ""}
							onChange={(event) => update({ trashRetentionDays: event.target.value })}
							disabled={!form || saving}
							className="max-w-40"
						/>
						<p className="text-sm text-neutral-500">A daily job deletes older trash and abandoned uploads.</p>
					</div>
					{status && (
						<p role="status" className={status.tone === "error" ? "text-sm text-red-600" : "text-sm text-neutral-700"}>
							{status.text}
						</p>
					)}
					<Button type="submit" disabled={!form || saving}>
						{saving ? "Saving…" : "Save settings"}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
