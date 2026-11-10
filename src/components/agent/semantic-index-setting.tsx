"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { Switch } from "@/components/ui/switch";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import {
	loadSemanticIndexState,
	semanticIndexSaveError,
	type SemanticIndexState,
} from "./semantic-index-setting-utils";

/**
 * "Include this mailbox in search by meaning", in the assistant settings, for the mailbox the panel is on now. Only
 * people who manage the mailbox can change it, and it applies to everyone with access. Turning it off deletes the
 * mailbox's vectors; turning it on queues its eligible messages again.
 */
export function SemanticIndexSetting({ mailboxId }: { mailboxId: string }) {
	const { mailboxes } = useSelectedMailbox();
	const mailbox = mailboxes.find((item) => item.id === mailboxId);
	const address = mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : "this mailbox";
	const [state, setState] = useState<SemanticIndexState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const next = await loadSemanticIndexState(mailboxId).catch(() => null);
		if (next) setState(next);
	}, [mailboxId]);

	useEffect(() => {
		// load only sets state after its request resolves.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	if (!state) return null;
	const { semanticIndex, canManage } = state;

	async function save(next: boolean) {
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/agent/settings/semantic", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, semanticIndex: next }),
			});
			if (!response.ok) return setError(await semanticIndexSaveError(response));
			setState((current) => current && { ...current, semanticIndex: next });
		} catch {
			setError("Could not save. Try again.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-labelledby={`semantic-index-heading-${mailboxId}`}
			className="space-y-2 rounded-2xl border border-neutral-200 p-3"
			data-testid="semantic-index-setting"
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p id={`semantic-index-heading-${mailboxId}`} className="font-medium text-neutral-800">
						Search by meaning
					</p>
					<p className="text-xs text-neutral-500">Find mail in {address} by what it means, not only its words.</p>
				</div>
				<Switch
					checked={semanticIndex}
					disabled={!canManage || busy}
					onCheckedChange={(checked) => void save(checked)}
					aria-label={`Search by meaning for ${address}`}
				/>
			</div>
			{error && (
				<p role="alert" className="text-xs text-red-700">
					{error}
				</p>
			)}
		</section>
	);
}
