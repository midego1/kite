"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import {
	ASSISTANT_EMAIL_DAILY_LIMIT_MAX,
	ASSISTANT_EMAIL_DAILY_LIMIT_MIN,
	parseDailyLimit,
} from "@/lib/agent/email/daily-limit-utils";
import {
	loadAssistantEmailSettings,
	saveAssistantEmailSettings,
	type AssistantEmailSettingsState,
} from "./assistant-email-setting-utils";

/**
 * The assistant-by-email opt-in (spec §13, §14): on only after an admin has created an address on a domain
 * (Domains → domain details); this card just lets the signed-in user turn it on for themselves, choose which of
 * their mailboxes a request from a verified extra address runs in, and set their own daily request limit.
 */
export function AssistantEmailSetting() {
	const [state, setState] = useState<AssistantEmailSettingsState | null>(null);
	const [limitText, setLimitText] = useState("");
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

	useEffect(() => {
		let active = true;
		loadAssistantEmailSettings()
			.then((loaded) => {
				if (!active) return;
				setState(loaded);
				setLimitText(String(loaded.dailyLimit));
			})
			.catch((error: unknown) => {
				if (active) setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load" });
			});
		return () => {
			active = false;
		};
	}, []);

	async function update(change: { enabled?: boolean; mailboxId?: string; dailyLimit?: number }) {
		setSaving(true);
		setMessage(null);
		try {
			const saved = await saveAssistantEmailSettings(change);
			setState(saved);
			setLimitText(String(saved.dailyLimit));
		} catch (error) {
			// A failed save leaves the saved value on screen, never the rejected draft.
			if (state) setLimitText(String(state.dailyLimit));
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to save" });
		} finally {
			setSaving(false);
		}
	}

	function commitDailyLimit() {
		if (!state) return;
		const parsed = parseDailyLimit(limitText);
		if (!parsed.ok) {
			setLimitText(String(state.dailyLimit));
			setMessage({ tone: "error", text: parsed.error });
			return;
		}
		if (parsed.value !== state.dailyLimit) void update({ dailyLimit: parsed.value });
		else setLimitText(String(parsed.value));
	}

	if (state && !state.ready)
		return <p className="text-xs text-neutral-500">Apply the pending database update to use the assistant by email.</p>;

	return (
		<div className="space-y-2 rounded-2xl border border-neutral-200 p-3">
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="font-medium text-neutral-800">Assistant by email</p>
					<p className="text-xs text-neutral-500">
						Email a request to the assistant address your admin set up on your domain, and get an answer with review
						links in Kite. Nothing is sent or changed without your confirmation here.
					</p>
				</div>
				<Switch
					checked={state?.enabled ?? false}
					disabled={!state || saving}
					onCheckedChange={(checked) => void update({ enabled: checked })}
					aria-label="Assistant by email"
				/>
			</div>
			{state?.enabled && (
				<>
					<label className="block">
						Mailbox for requests from a verified extra address
						<Select
							containerClassName="mt-2 w-full rounded-xl bg-white"
							className="p-2"
							// Nothing chosen yet means intake uses the oldest personal mailbox, which the list puts first.
							value={state.mailboxId ?? state.mailboxes[0]?.id ?? ""}
							disabled={saving}
							onChange={(event) => void update({ mailboxId: event.target.value })}
						>
							{state.mailboxes.map((mailbox) => (
								<option key={mailbox.id} value={mailbox.id}>
									{mailbox.label}
								</option>
							))}
						</Select>
						<span className="mt-1 block text-xs text-neutral-500">
							Until you choose one, requests run in your oldest personal mailbox. A request from your own mailbox
							address always runs there instead.
						</span>
					</label>
					<label className="block">
						Daily request limit
						<input
							className="mt-2 w-full rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
							type="number"
							min={ASSISTANT_EMAIL_DAILY_LIMIT_MIN}
							max={ASSISTANT_EMAIL_DAILY_LIMIT_MAX}
							value={limitText}
							disabled={saving}
							onChange={(event) => setLimitText(event.target.value)}
							onBlur={commitDailyLimit}
						/>
					</label>
				</>
			)}
			{message && (
				<p role="status" className={`text-xs ${message.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
					{message.text}
				</p>
			)}
		</div>
	);
}
