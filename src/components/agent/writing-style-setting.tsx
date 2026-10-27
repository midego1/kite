"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import {
	loadWritingStyle,
	resetWritingStyle,
	saveWritingStyleEnabled,
	startWritingStyleBackfill,
	type WritingStyleState,
} from "./writing-style-utils";

const LABEL = "Learn my writing style from mail I send";

/**
 * The writing style opt-in, off by default, and per mailbox what Kite learnt: the sample count, exactly the text it
 * tells the AI, and Reset. Hidden until migration 0070 is applied.
 */
export function WritingStyleSetting() {
	const confirm = useConfirm();
	const [state, setState] = useState<WritingStyleState | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setState(await loadWritingStyle());
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load your writing style");
		}
	}, []);

	useEffect(() => {
		let active = true;
		loadWritingStyle()
			.then((loaded) => active && setState(loaded))
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);

	async function run(action: () => Promise<void>) {
		setBusy(true);
		setMessage(null);
		try {
			await action();
			await refresh();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save");
		} finally {
			setBusy(false);
		}
	}

	async function toggle(enabled: boolean) {
		if (!enabled) {
			const confirmed = await confirm({
				title: "Turn off and delete your writing style?",
				description:
					"Kite stops learning and using your writing style at once and deletes what it learnt in every mailbox.",
				confirmLabel: "Turn off and delete",
			});
			if (confirmed) await run(() => saveWritingStyleEnabled(false));
			return;
		}
		await run(async () => {
			await saveWritingStyleEnabled(true);
			const loaded = await loadWritingStyle();
			const backfill = await confirm({
				title: "Learn from mail you already sent?",
				description:
					"Kite can also learn from the last 200 messages you sent from the composer in each mailbox. Messages that Write with Kite helped write are left out.",
				confirmLabel: "Learn from sent mail",
				cancelLabel: "Only from now on",
				destructive: false,
			});
			if (backfill) for (const profile of loaded.profiles) await startWritingStyleBackfill(profile.mailboxId);
		});
	}

	if (!state?.available) return null;
	return (
		<section aria-labelledby="writing-style-heading" className="space-y-2 rounded-2xl border border-neutral-200 p-3">
			<div className="flex items-center justify-between gap-3">
				<p id="writing-style-heading" className="font-medium text-neutral-800">
					Writing style
				</p>
				<Switch
					checked={state.enabled}
					disabled={busy}
					onCheckedChange={(checked) => void toggle(checked)}
					aria-label={LABEL}
				/>
			</div>
			<p className="text-xs text-neutral-500">
				{LABEL}: Kite keeps statistics about how you write (length, greetings, sign-offs, tone), never your text, and
				uses them when it drafts for you. Only you can see them.
			</p>
			{state.enabled &&
				state.profiles.map((profile) => (
					<div key={profile.mailboxId} className="space-y-1 rounded-xl bg-neutral-50 p-2 dark:bg-neutral-900">
						<div className="flex items-center justify-between gap-2">
							<p className="truncate text-sm font-medium text-neutral-800">{profile.address}</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy || profile.sampleCount === 0}
								aria-label={`Reset writing style for ${profile.address}`}
								onClick={() => void run(() => resetWritingStyle(profile.mailboxId))}
							>
								Reset
							</Button>
						</div>
						<p className="text-xs text-neutral-500">
							{profile.backfillPending
								? "Learning from your sent mail…"
								: `Learnt from ${profile.sampleCount} sent ${profile.sampleCount === 1 ? "message" : "messages"}.`}
						</p>
						{profile.description ? (
							<figure className="space-y-1">
								<figcaption className="text-xs text-neutral-500">This is what Kite tells the AI:</figcaption>
								<blockquote className="border-l-2 border-blue-300 pl-2 text-xs text-neutral-700">
									{profile.description}
								</blockquote>
							</figure>
						) : (
							<p className="text-xs text-neutral-500">Kite needs 10 sent messages before it uses your style.</p>
						)}
					</div>
				))}
			{message && (
				<p role="status" className="text-xs text-red-600">
					{message}
				</p>
			)}
		</section>
	);
}
