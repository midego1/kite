"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { Switch } from "@/components/ui/switch";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { MAILBOXES_CHANGED_EVENT, clearMailboxesCache } from "@/components/mailbox-provider-utils";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import {
	loadMailboxAiState,
	mailboxAiConfirmation,
	mailboxAiSaveError,
	type MailboxAiState,
} from "./mailbox-ai-setting-utils";

/**
 * "No AI for this mailbox", at the top of the assistant settings, for the mailbox the panel is on now (never one a
 * late settings response named). Only people who manage the mailbox can change it, and it applies to everyone with
 * access. Turning it on asks first, because it deletes the mailbox's summaries; it calls no model.
 */
export function MailboxAiSetting({ mailboxId, onChange }: { mailboxId: string; onChange?: () => void }) {
	const { mailboxes } = useSelectedMailbox();
	const mailbox = mailboxes.find((item) => item.id === mailboxId);
	const address = mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : "this mailbox";
	const [state, setState] = useState<MailboxAiState | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const next = await loadMailboxAiState(mailboxId);
			setLoadFailed(!next);
			if (next) setState(next);
		} catch {
			setLoadFailed(true);
		}
	}, [mailboxId]);

	useEffect(() => {
		// load only sets state after its request resolves.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	// While the database update is pending, look again when the window regains focus: it may be applied elsewhere.
	useEffect(() => {
		if (!state || state.ready) return;
		const onFocus = () => void load();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [state, load]);

	if (!state)
		return loadFailed ? (
			<p role="alert" className="text-xs text-red-700" data-testid="mailbox-ai-setting-error">
				Could not load No AI for this mailbox.{" "}
				<button type="button" className="text-blue-700 underline" onClick={() => void load()}>
					Try again
				</button>
			</p>
		) : null;
	const { aiDisabled, ready, canManage } = state;

	async function save(next: boolean) {
		if (next && !(await requestConfirmation(mailboxAiConfirmation(address)))) return;
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/agent/settings/ai", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, aiDisabled: next }),
			});
			if (!response.ok) return setError(await mailboxAiSaveError(response));
			setState((current) => current && { ...current, aiDisabled: next });
			onChange?.();
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
				<div className="min-w-0">
					<p id={`mailbox-ai-heading-${mailboxId}`} className="font-medium text-neutral-800">
						No AI for this mailbox
					</p>
					<p className="truncate text-xs text-neutral-500" data-testid="mailbox-ai-setting-address">
						{address}
					</p>
				</div>
				<Switch
					checked={aiDisabled}
					disabled={!canManage || !ready || busy}
					onCheckedChange={(checked) => void save(checked)}
					aria-label={`No AI for ${address}`}
				/>
			</div>
			<p className="text-xs text-neutral-600">
				Kite sends nothing from this mailbox to an AI provider: no chat, Write with Kite, summaries, translations,
				suggestions or automatic reading, for everyone who can open it. Turning it on deletes its summaries. Earlier
				chats are not rewritten; Kite stops sending their older messages to the AI, and a new chat starts clean. API
				keys, MCP and JMAP can still read the mailbox, and so can an AI app you connect with such a key.
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
