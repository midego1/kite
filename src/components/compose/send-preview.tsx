"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatUserDate } from "@/lib/time/utils";
import { buildPreviewDocument, formatPreviewAttachments } from "./send-preview-utils";
import type { SendPreviewProps } from "./send-preview-types";

export function SendPreview({
	from,
	to,
	cc,
	bcc,
	subject,
	html,
	attachmentNames,
	scheduledAt,
	busy,
	onCancel,
	onConfirm,
}: SendPreviewProps) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	const confirmButton = useRef<HTMLButtonElement | null>(null);
	const [frameHeight, setFrameHeight] = useState(240);
	const document = useMemo(() => buildPreviewDocument(html), [html]);
	const attachments = formatPreviewAttachments(attachmentNames);

	useEffect(() => {
		confirmButton.current?.focus();
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape" && !busy) onCancel();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [busy, onCancel]);

	function measure() {
		const body = frame.current?.contentDocument?.body;
		if (body) setFrameHeight(Math.max(160, body.scrollHeight + 8));
	}

	return (
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/60 p-4"
			role="dialog"
			aria-modal="true"
			aria-label="Preview email before sending"
		>
			<div className="flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
				<div className="border-b border-neutral-100 p-5">
					<h2 className="text-lg font-semibold">{scheduledAt ? "Preview and schedule" : "Preview and send"}</h2>
					<dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-sm break-words">
						<dt className="text-neutral-500">From</dt>
						<dd>{from}</dd>
						<dt className="text-neutral-500">To</dt>
						<dd>{to}</dd>
						{cc && (
							<>
								<dt className="text-neutral-500">Cc</dt>
								<dd>{cc}</dd>
							</>
						)}
						{bcc && (
							<>
								<dt className="text-neutral-500">Bcc</dt>
								<dd>{bcc}</dd>
							</>
						)}
						<dt className="text-neutral-500">Subject</dt>
						<dd>{subject || <span className="text-neutral-400">(no subject)</span>}</dd>
						{scheduledAt && (
							<>
								<dt className="text-neutral-500">Send at</dt>
								<dd>{formatUserDate(scheduledAt.toISOString(), { dateStyle: "medium", timeStyle: "short" })}</dd>
							</>
						)}
						{attachments && (
							<>
								<dt className="text-neutral-500">Files</dt>
								<dd>{attachments}</dd>
							</>
						)}
					</dl>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto bg-neutral-100 p-4">
					{/* allow-same-origin without allow-scripts: nothing in the message runs, but the frame can be measured. */}
					<iframe
						ref={frame}
						title="Message preview"
						sandbox="allow-same-origin"
						srcDoc={document}
						onLoad={measure}
						style={{ height: frameHeight }}
						className="w-full rounded-lg border border-neutral-200 bg-white"
					/>
				</div>
				<div className="flex items-center justify-between gap-3 border-t border-neutral-100 p-4">
					<p className="text-xs text-neutral-500">Mail clients render messages slightly differently.</p>
					<div className="flex gap-3">
						<button type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={onCancel} disabled={busy}>
							Keep editing
						</button>
						<button
							ref={confirmButton}
							type="button"
							className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							onClick={onConfirm}
							disabled={busy}
						>
							{busy ? "Sending…" : scheduledAt ? "Confirm and schedule" : "Confirm and send"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
