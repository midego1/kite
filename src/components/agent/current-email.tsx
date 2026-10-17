"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { fetchCachedMessageDetail } from "@/lib/messages/detail-cache";
import { useKeyChanged } from "@/hooks/use-synced-state";

/**
 * The open email the next chat message refers to: only one from the selected mailbox, and not one
 * the user removed from the chat. `ref` holds it for queued messages, which send later and must
 * read the email that is open at that moment rather than when they were queued.
 */
export function useCurrentEmail(selectedMessageId: string | null, mailboxId: string | undefined) {
	const [subjects, setSubjects] = useState<Record<string, string>>({});
	const [dismissedId, setDismissedId] = useState<string | null>(null);
	const ref = useRef<string | null>(null);
	if (useKeyChanged(selectedMessageId)) setDismissedId(null);
	const contextMessageId = selectedMessageId !== dismissedId ? selectedMessageId : null;
	const openEmailId = contextMessageId && contextMessageId in subjects ? contextMessageId : null;

	useEffect(() => {
		if (!selectedMessageId || !mailboxId) return;
		let active = true;
		void fetchCachedMessageDetail(selectedMessageId)
			.then(({ message }) => {
				if (active && message?.mailboxId === mailboxId)
					setSubjects((current) => ({ ...current, [selectedMessageId]: message.subject ?? "" }));
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [selectedMessageId, mailboxId]);

	useEffect(() => {
		ref.current = openEmailId;
	}, [openEmailId]);

	return {
		contextMessageId,
		openEmailId,
		subject: openEmailId ? subjects[openEmailId] : "",
		ref,
		dismiss: () => setDismissedId(openEmailId),
	};
}

export function CurrentEmailChip({ email }: { email: ReturnType<typeof useCurrentEmail> }) {
	if (!email.openEmailId) return null;
	return (
		<div className="mx-auto flex w-full max-w-3xl px-4 pb-1">
			<span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 py-1 pl-3 pr-1 text-xs text-blue-800">
				<FileText size={12} className="shrink-0" aria-hidden="true" />
				<span className="truncate">Current email: {email.subject || "(No subject)"}</span>
				<button
					type="button"
					onClick={email.dismiss}
					className="shrink-0 rounded-full p-0.5 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
					aria-label="Don’t use this email"
					title="Don’t use this email"
				>
					<X size={12} aria-hidden="true" />
				</button>
			</span>
		</div>
	);
}
