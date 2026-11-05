"use client";

import { useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { Switch } from "@/components/ui/switch";
import { MAILBOXES_CHANGED_EVENT, clearMailboxesCache } from "@/components/mailbox-provider-utils";
import { mailboxAiSaveError } from "./mailbox-ai-setting-utils";

/**
 * "No AI for this mailbox", at the top of the mailbox's assistant settings. Only people who manage the mailbox can
 * change it, and it applies to everyone with access. Turning it on calls no model.
 */
export function MailboxAiSetting({
	mailboxId,
	aiDisabled,
	ready,
	canManage,
	onChange,
}: {
	mailboxId: string;
	aiDisabled: boolean;
	/** False until migration 0091, when the switch cannot be saved yet. */
	ready: boolean;
	canManage: boolean;
	onChange: (aiDisabled: boolean) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save(next: boolean) {
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/agent/settings/ai", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, aiDisabled: next }),
			});
			if (!response.ok) return setError(await mailboxAiSaveError(response));
			onChange(next);
			// The mailbox list carries the switch, so Write with Kite and the reader follow it at once.
			clearMailboxesCache();
			window.dispatchEvent(new Event(MAILBOXES_CHANGED_EVENT));
		} catch {
			setError("Could not save. Try again.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-labelledby={`mailbox-ai-heading-${mailboxId}`}
			className="space-y-2 rounded-2xl border border-neutral-200 p-3"
			data-testid="mailbox-ai-setting"
		>
			<div className="flex items-center justify-between gap-3">
				<p id={`mailbox-ai-heading-${mailboxId}`} className="font-medium text-neutral-800">
					No AI for this mailbox
				</p>
				<Switch
					checked={aiDisabled}
					disabled={!canManage || !ready || busy}
					onCheckedChange={(checked) => void save(checked)}
					aria-label="No AI for this mailbox"
				/>
			</div>
			<p className="text-xs text-neutral-600">
				Nothing from this mailbox is sent to the AI: no chat, Write with Kite, summaries, translations, suggestions or
				automatic reading. It applies to everyone who can open the mailbox. Turning it on removes its suggestions and
				summaries.
			</p>
			{!ready && <p className="text-xs text-amber-700">Apply the pending database update to use this setting.</p>}
			{error && (
				<p role="alert" className="text-xs text-red-700">
					{error}
				</p>
			)}
		</section>
	);
}
