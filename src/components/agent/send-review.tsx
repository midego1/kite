"use client";

import { useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import { htmlToPlainText } from "@/components/compose/rich-text-utils";
import { DRAFT_CHANGED_ERROR } from "@/lib/agent/approvals/snapshot-utils";
import type { SendReviewProps } from "./send-review-types";

/** Who wrote the draft, and the recipients the user has never written to or saved (upstream Mailflare #225). */
function ReviewNotices({ unfamiliarRecipients }: { unfamiliarRecipients: string[] }) {
	const one = unfamiliarRecipients.length === 1;
	return (
		<>
			<p
				className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"
				data-send-review-ai-origin=""
			>
				The AI assistant wrote this message, partly from email content that anyone could have written. Read it before
				sending.
			</p>
			{unfamiliarRecipients.length > 0 && (
				<p
					className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800 break-words"
					data-send-review-unfamiliar=""
				>
					You have never written to {one ? "this address" : "these addresses"} and {one ? "it is" : "they are"} not in
					your contacts: {unfamiliarRecipients.join(", ")}. Check that you mean to send this to {one ? "it" : "them"}.
				</p>
			)}
		</>
	);
}

export function SendReview({
	approvalId,
	snapshot,
	unfamiliarRecipients = [],
	onClose,
	onReviewAgain,
	onSent,
}: SendReviewProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch(`/api/agent/approvals/${approvalId}/confirm`, { method: "POST" });
			const result = (await response.json()) as { status?: string; messageId?: string; error?: string };
			if (!response.ok || result.status !== "sent" || !result.messageId)
				throw new Error(result.error || "Delivery needs review");
			window.dispatchEvent(new Event("kite:messages-changed"));
			onSent?.(result.messageId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not send");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
			role="dialog"
			aria-modal="true"
			aria-label="Review email before sending"
		>
			<div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-neutral-200 bg-white p-5 shadow-lg">
				<h2 className="text-lg font-semibold">{snapshot.scheduledAt ? "Review and schedule" : "Review and send"}</h2>
				<p className="mt-1 text-sm text-neutral-500">
					Confirm this exact AI draft before it is {snapshot.scheduledAt ? "scheduled" : "delivered"}.
				</p>
				<ReviewNotices unfamiliarRecipients={unfamiliarRecipients} />
				<dl className="mt-4 grid grid-cols-[5rem_1fr] gap-2 text-sm break-words">
					<dt className="text-neutral-500">From</dt>
					<dd>{snapshot.from}</dd>
					<dt className="text-neutral-500">To</dt>
					<dd>{snapshot.to}</dd>
					{snapshot.cc && (
						<>
							<dt className="text-neutral-500">Cc</dt>
							<dd>{snapshot.cc}</dd>
						</>
					)}
					{snapshot.bcc && (
						<>
							<dt className="text-neutral-500">Bcc</dt>
							<dd>{snapshot.bcc}</dd>
						</>
					)}
					<dt className="text-neutral-500">Subject</dt>
					<dd>{snapshot.subject}</dd>
					{snapshot.scheduledAt && (
						<>
							<dt className="text-neutral-500">Send at</dt>
							<dd>{formatUserDate(snapshot.scheduledAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
						</>
					)}
				</dl>
				<pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-neutral-200 p-3 text-sm">
					{snapshot.text || htmlToPlainText(snapshot.html || "")}
				</pre>
				{snapshot.attachments.length > 0 && (
					<p className="mt-3 text-sm">Attachments: {snapshot.attachments.map((item) => item.filename).join(", ")}</p>
				)}
				{error && (
					<p role="alert" className="mt-3 text-sm text-red-600">
						{error}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-3">
					{onClose && (
						<button type="button" className="rounded-lg border px-4 py-2" onClick={onClose} disabled={busy}>
							Cancel
						</button>
					)}
					{error === DRAFT_CHANGED_ERROR && onReviewAgain ? (
						<button
							type="button"
							className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white"
							onClick={() => {
								setError(null);
								onReviewAgain();
							}}
						>
							Review again
						</button>
					) : (
						<button
							type="button"
							className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50"
							onClick={() => void confirm()}
							disabled={busy}
						>
							{busy
								? snapshot.scheduledAt
									? "Scheduling…"
									: "Sending…"
								: snapshot.scheduledAt
									? "Confirm and schedule"
									: "Confirm and send"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
