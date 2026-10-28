"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { loadAutoReadSettings, saveAutoReadSettings } from "./auto-read-settings-utils";

type Form = { enabled: boolean; bulk: boolean; limit: string };
type Status = { tone: "ok" | "error"; text: string } | null;

const fieldClass =
	"mt-2 w-full rounded-xl border border-neutral-200 bg-white p-2 outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-60";

/** The daily limit as typed, or an error message: a whole number from 1 to 1,000. */
function parseLimit(value: string): number | string {
	const limit = Number(value);
	return Number.isInteger(limit) && limit >= 1 && limit <= 1_000
		? limit
		: "The daily one-line summary limit must be between 1 and 1000";
}

/**
 * Settings → Summaries for one mailbox: one-line summaries of new mail in the message list (off by default),
 * whether newsletters and notifications get one too, and a daily limit. Only people who manage the mailbox can
 * change them; the lines follow every automatic-reading switch, opt-in and cap.
 */
export function ListSummarySettings({ mailboxId }: { mailboxId: string }) {
	const [form, setForm] = useState<Form | null>(null);
	const [canManage, setCanManage] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<Status>(null);

	useEffect(() => {
		let active = true;
		loadAutoReadSettings(mailboxId)
			.then((data) => {
				if (!active) return;
				setCanManage(!!data.canManage);
				setForm({
					enabled: !!data.settings.listSummaries,
					bulk: !!data.settings.listSummariesBulk,
					limit: String(data.settings.listSummaryDailyLimit ?? 100),
				});
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [mailboxId]);

	if (!form) return null;
	const locked = !canManage || busy;

	async function save() {
		if (!form) return;
		const limit = parseLimit(form.limit);
		if (typeof limit === "string") return setStatus({ tone: "error", text: limit });
		setBusy(true);
		setStatus(null);
		try {
			await saveAutoReadSettings({
				mailboxId,
				listSummaries: form.enabled,
				listSummariesBulk: form.bulk,
				listSummaryDailyLimit: limit,
			});
			setStatus({ tone: "ok", text: "Saved" });
		} catch (error) {
			setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-labelledby={`list-summaries-heading-${mailboxId}`}
			className="space-y-3 rounded-2xl border border-neutral-200 p-3"
		>
			<p id={`list-summaries-heading-${mailboxId}`} className="font-medium text-neutral-800">
				Summaries
			</p>
			<p className="text-xs text-neutral-500">
				Kite can write a one-line summary of new mail and show it in the message list instead of the first words. It
				uses automatic reading&apos;s model, switches and caps, and never summarises spam, suspicious mail or mail the
				Screener holds.
			</p>
			<div className="flex items-center justify-between gap-3">
				<span>One-line summaries in the message list</span>
				<Switch
					checked={form.enabled}
					disabled={locked}
					aria-label="One-line summaries in the message list"
					onCheckedChange={(enabled) => setForm({ ...form, enabled })}
				/>
			</div>
			<div className="flex items-center justify-between gap-3">
				<span>Include newsletters and notifications</span>
				<Switch
					checked={form.bulk}
					disabled={locked}
					aria-label="Include newsletters and notifications"
					onCheckedChange={(bulk) => setForm({ ...form, bulk })}
				/>
			</div>
			<label className="block">
				Daily one-line summary limit
				<input
					className={fieldClass}
					type="number"
					min="1"
					max="1000"
					value={form.limit}
					disabled={locked}
					onChange={(event) => setForm({ ...form, limit: event.target.value })}
				/>
			</label>
			{canManage && (
				<Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
					Save summaries
				</Button>
			)}
			{status && (
				<p role="status" className={`text-xs ${status.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
					{status.text}
				</p>
			)}
		</section>
	);
}
